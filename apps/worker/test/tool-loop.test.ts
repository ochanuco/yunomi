import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	type CapabilityAdapter,
	type CapabilityRequest,
	calendarCreateEvent,
	calendarListEvents,
	createCapabilityGate,
	createToolRegistry,
	PENDING_TTL_MS,
	type PendingOperation,
	type PendingStore,
	readAttachment,
} from "@yunomi/capabilities";
import { ok, validationFailed } from "@yunomi/core";
import {
	FakeLLMProvider,
	HAIKU,
	type LLMProvider,
	ModelRouter,
	SONNET,
	type StepMessage,
	type StepRequest,
} from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { MAX_TOOL_ROUNDS, TOOL_LOOP_TIMEOUT_MS } from "../src/do/tool-loop.ts";
import { inbound, partnerStub } from "./helpers.ts";
import { final, meta, toolUse, turnResponse } from "./llm-fixtures.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const OWNER = "u1";
const GUEST = "u2";
const T0 = new Date("2026-10-11T03:00:00Z");

const listInput = {
	from: "2026-10-12T00:00:00+09:00",
	to: "2026-10-13T00:00:00+09:00",
};
const createInput = {
	summary: "歯医者",
	start: "2026-10-12T19:00:00+09:00",
	end: "2026-10-12T20:00:00+09:00",
	description: null,
};

/** DO ごとに FakeLLM・時計・gate（fake の adapter とメモリ上の保留）を差し込む。 */
const setup = async (name: string, opts: { executeCostMs?: number } = {}) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	const clock = { now: T0 };
	const calls: CapabilityRequest[] = [];
	const ops = new Map<string, PendingOperation>();

	const adapter: CapabilityAdapter = {
		tools: [calendarListEvents, calendarCreateEvent],
		execute: async (request) => {
			calls.push(request);
			clock.now = new Date(clock.now.getTime() + (opts.executeCostMs ?? 0));
			return ok(
				request.tool === "calendar_list_events"
					? {
							data: {
								events: [
									{
										summary: "歯医者",
										start: "2026-10-12T19:00:00+09:00",
										end: "2026-10-12T20:00:00+09:00",
										allDay: false,
										location: null,
									},
								],
								truncated: false,
							},
							summary: "予定 1 件を取得",
						}
					: { data: { created: true }, summary: "予定を 1 件登録" },
			);
		},
	};
	const pending: PendingStore = {
		listOpen: async (partnerId, channelId) =>
			[...ops.values()].filter(
				(op) =>
					op.partnerId === partnerId &&
					op.channelId === channelId &&
					op.status === "proposed",
			),
		get: async (partnerId, id) => {
			const op = ops.get(id);
			return op?.partnerId === partnerId ? op : null;
		},
		save: async (saved) => {
			for (const op of saved) ops.set(op.id, op);
		},
	};
	const registry = createToolRegistry([adapter]);
	if (!registry.ok) throw new Error("登録簿を作れない");
	const gate = createCapabilityGate({
		registry: registry.value,
		policy: { calendar_read: "auto", calendar_write: "confirm" },
		pending,
		now: () => clock.now,
	});
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
		o.capabilities = { gate, pending, isOwner: (id) => id === OWNER };
	});
	return { stub, fake, clock, calls, ops };
};

const ask = (text: string, over = {}) =>
	inbound({ mentionedUserIds: [BOT], content: text, ...over });

const lastToolResults = (req: StepRequest<unknown> | undefined) => {
	const msg = req?.messages
		.filter(
			(m): m is Extract<StepMessage, { role: "tool_results" }> =>
				m.role === "tool_results",
		)
		.at(-1);
	return (msg?.results ?? []).map((r) => ({
		...r,
		body: JSON.parse(r.content) as Record<string, unknown>,
	}));
};

const systemText = (req: StepRequest<unknown> | undefined) =>
	(req?.system ?? []).map((b) => b.text).join("\n");

describe("道具を持たないターン", () => {
	it("capabilities が無ければ今まで通り generate で返し、toolCalls は空", async () => {
		const stub = partnerStub("no-tools");
		const fake = new FakeLLMProvider();
		fake.enqueue({
			ok: true,
			value: { output: turnResponse("こんにちは"), ...meta(HAIKU) },
		});
		await runInDurableObject(stub, (o) => {
			o.now = () => T0;
			o.createRouter = () => new ModelRouter({ provider: fake });
		});
		const res = await stub.handleDiscordMessage(ask("やあ"));
		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "こんにちは" }],
		});
		expect(res.audit.toolCalls).toEqual([]);
		expect(fake.requests).toHaveLength(1);
		expect(fake.stepRequests).toHaveLength(0);
		const text = JSON.stringify(fake.requests[0]?.system);
		expect(text).not.toContain("## 道具");
		expect(text).not.toContain("## 保留中の操作");
	});
});

describe("予定の確認", () => {
	it("tool_use を gate が auto で実行し、結果を受けてから同じターンで返す", async () => {
		const { stub, fake, calls } = await setup("list");
		fake.enqueueStep(
			toolUse([{ name: "calendar_list_events", input: listInput }]),
			final("明日は 19 時から歯医者の予定がありますよ"),
		);
		const msg = ask("明日の予定ある？");
		const res = await stub.handleDiscordMessage(msg);

		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "明日は 19 時から歯医者の予定がありますよ" }],
			reply_to_message_id: msg.messageId,
		});
		expect(fake.requests).toHaveLength(0);
		expect(fake.stepRequests).toHaveLength(2);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.context).toMatchObject({
			partnerId: "yukarin",
			speakerId: OWNER,
			isOwner: true,
			channelId: "c1",
			sourceMessageId: msg.messageId,
		});

		const results = lastToolResults(fake.stepRequests[1]);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: "tu_0", isError: false });
		expect(JSON.stringify(results[0]?.body)).toContain("歯医者");
		expect(fake.stepRequests[1]?.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"tool_results",
		]);

		expect(res.audit.toolCalls).toEqual([
			{
				tool: "calendar_list_events",
				decision: "auto",
				outcome: "ok",
				summary: "予定 1 件を取得",
				pendingId: null,
				latencyMs: expect.any(Number),
			},
		]);
		expect(res.audit.usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 40,
		});
		expect(res.audit.decision).toBe("reply");
	});

	it("プロンプトに道具の規則・現在日時・発言者の立場を載せ、gate の定義を道具として渡す", async () => {
		const { stub, fake } = await setup("prompt");
		fake.enqueueStep(final("はい"));
		await stub.handleDiscordMessage(ask("こんにちは"));

		const req = fake.stepRequests[0];
		expect(req?.tools.map((t) => t.name)).toEqual([
			"calendar_list_events",
			"calendar_create_event",
			"pending_confirm",
			"pending_cancel",
		]);
		const schema = req?.tools[1]?.inputSchema as {
			properties: Record<string, unknown>;
			additionalProperties: boolean;
		};
		expect(Object.keys(schema.properties)).toEqual([
			"summary",
			"start",
			"end",
			"description",
		]);
		expect(schema.additionalProperties).toBe(false);
		const text = systemText(req);
		expect(text).toContain("## 道具");
		expect(text).toContain("- 2026-10-11 12:00 JST（日）");
		expect(text).toContain("- 新着メッセージの発言者: オーナー\n（なし）");
		expect(req?.system.find((b) => b.text.startsWith("## 道具"))?.cache).toBe(
			true,
		);
	});

	it("2 回目以降の step は、1 回目の結果のモデルを指定する", async () => {
		const { stub, fake } = await setup("pin-model");
		fake.enqueueStep(
			toolUse([{ name: "calendar_list_events", input: listInput }], HAIKU),
			toolUse([{ name: "calendar_list_events", input: listInput }], SONNET),
			final("おわり", HAIKU),
		);
		await stub.handleDiscordMessage(ask("予定を教えて"));
		expect(fake.stepRequests.map((r) => r.model)).toEqual([
			SONNET,
			HAIKU,
			HAIKU,
		]);
	});

	it("ToolCallRecord は D1 の audit の detail に残る", async () => {
		const { stub, fake } = await setup("audit-detail");
		fake.enqueueStep(
			toolUse([{ name: "calendar_list_events", input: listInput }]),
			final("あります"),
		);
		const msg = ask("明日の予定ある？");
		await stub.handleDiscordMessage(msg);
		await stub.flushBackground();
		const row = await env.DB.prepare(
			"SELECT detail_json FROM audit_events WHERE event_id = ?",
		)
			.bind(msg.eventId)
			.first<{ detail_json: string }>();
		const detail = JSON.parse(row?.detail_json ?? "{}");
		expect(detail.toolCalls).toHaveLength(1);
		expect(detail.toolCalls[0]).toMatchObject({
			tool: "calendar_list_events",
			decision: "auto",
		});
		expect(detail).not.toHaveProperty("toolIntents");
	});
});

describe("登録の提案・了承・取り消し", () => {
	const propose = async (name: string) => {
		const ctx = await setup(name);
		ctx.fake.enqueueStep(
			toolUse([{ name: "calendar_create_event", input: createInput }]),
			final("18日 19:00 から歯医者、で入れていい？"),
		);
		const msg = ask("明日19時に歯医者入れて");
		const res = await ctx.stub.handleDiscordMessage(msg);
		return { ...ctx, msg, res };
	};

	it("calendar_create_event は保留にして聞き返し、adapter は呼ばれない", async () => {
		const { fake, calls, ops, res } = await propose("propose");
		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "18日 19:00 から歯医者、で入れていい？" }],
		});
		expect(calls).toHaveLength(0);
		expect(ops.size).toBe(1);
		const [op] = [...ops.values()];
		expect(op).toMatchObject({
			status: "proposed",
			tool: "calendar_create_event",
			input: createInput,
			requestedBy: OWNER,
			channelId: "c1",
		});
		const results = lastToolResults(fake.stepRequests[1]);
		expect(results[0]?.isError).toBe(false);
		expect(results[0]?.body).toMatchObject({
			status: "pending_confirmation",
			pending_id: op?.id,
		});
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "calendar_create_event",
			decision: "confirm",
			outcome: "pending",
			pendingId: op?.id,
		});
	});

	it("次のターンのプロンプトに保留が載り、了承で元の発言 ID の adapter 実行になる", async () => {
		const { stub, fake, calls, ops, msg } = await propose("confirm");
		const [op] = [...ops.values()];
		if (!op) throw new Error("保留があるはず");

		fake.enqueueStep(
			toolUse([{ name: "pending_confirm", input: { pending_id: op.id } }]),
			final("入れました"),
		);
		const res = await stub.handleDiscordMessage(
			inbound({ content: "うん", mentionedUserIds: [BOT] }),
		);

		const pendingBlock = systemText(fake.stepRequests[2]);
		expect(pendingBlock).toContain(
			`- [${op.id}] calendar_create_event ${JSON.stringify(createInput)}（期限 12:10 JST）`,
		);
		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "入れました" }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tool: "calendar_create_event",
			input: createInput,
		});
		expect(calls[0]?.context.sourceMessageId).toBe(msg.messageId);
		expect(ops.get(op.id)).toMatchObject({
			status: "executed",
			resolvedAt: T0.toISOString(),
		});
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "pending_confirm",
			decision: "pending_confirm",
			outcome: "ok",
			pendingId: op.id,
		});
	});

	it("提案と同じターンで pending_confirm を呼んでも実行されず、保留は残る", async () => {
		const { stub, fake, calls, ops } = await setup("same-turn-confirm");
		// 台本は前もって固定するので、2 往復目の pending_id は 1 往復目の結果から拾う。
		const provider: LLMProvider = {
			generate: (req) => fake.generate(req),
			step: (req) => {
				if (fake.stepRequests.length === 1) {
					const pendingId = lastToolResults(req as StepRequest<unknown>)[0]
						?.body.pending_id;
					fake.enqueueStep(
						toolUse([
							{ name: "pending_confirm", input: { pending_id: pendingId } },
						]),
						final("入れておきました"),
					);
				}
				return fake.step(req);
			},
		};
		await runInDurableObject(stub, (o) => {
			o.createRouter = () => new ModelRouter({ provider });
		});
		fake.enqueueStep(
			toolUse([{ name: "calendar_create_event", input: createInput }]),
		);
		const res = await stub.handleDiscordMessage(ask("明日19時に歯医者入れて"));

		expect(calls).toHaveLength(0);
		const [op] = [...ops.values()];
		expect(op?.status).toBe("proposed");
		expect(res.audit.toolCalls).toMatchObject([
			{ decision: "confirm", outcome: "pending", pendingId: op?.id },
			{
				decision: "pending_confirm",
				outcome: "error",
				summary: "same_turn_confirmation",
				pendingId: op?.id,
			},
		]);
		expect(lastToolResults(fake.stepRequests[2])[0]).toMatchObject({
			isError: true,
			body: { status: "rejected", reason: "same_turn_confirmation" },
		});
	});

	it("取り消しで cancelled になり、実行されない", async () => {
		const { stub, fake, calls, ops } = await propose("cancel");
		const [op] = [...ops.values()];
		if (!op) throw new Error("保留があるはず");

		fake.enqueueStep(
			toolUse([{ name: "pending_cancel", input: { pending_id: op.id } }]),
			final("やめておきますね"),
		);
		const res = await stub.handleDiscordMessage(
			inbound({ content: "やっぱりやめて", mentionedUserIds: [BOT] }),
		);
		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "やめておきますね" }],
		});
		expect(ops.get(op.id)?.status).toBe("cancelled");
		expect(calls).toHaveLength(0);
		expect(res.audit.toolCalls[0]).toMatchObject({
			decision: "pending_cancel",
			outcome: "cancelled",
		});
		expect(lastToolResults(fake.stepRequests[3])[0]?.body).toEqual({
			status: "cancelled",
		});
	});

	it("期限が切れた保留はプロンプトに載らず、ターンの頭で expired になり、了承されても実行されない", async () => {
		const { stub, fake, calls, ops, clock } = await propose("expired");
		const [op] = [...ops.values()];
		if (!op) throw new Error("保留があるはず");

		clock.now = new Date(T0.getTime() + PENDING_TTL_MS + 1000);
		fake.enqueueStep(
			toolUse([{ name: "pending_confirm", input: { pending_id: op.id } }]),
			final("期限が切れていました"),
		);
		const res = await stub.handleDiscordMessage(
			inbound({ content: "うん", mentionedUserIds: [BOT] }),
		);
		expect(systemText(fake.stepRequests[2])).not.toContain(op.id);
		expect(calls).toHaveLength(0);
		expect(ops.get(op.id)).toMatchObject({
			status: "expired",
			resolvedAt: clock.now.toISOString(),
		});
		expect(res.audit.toolCalls[0]).toMatchObject({
			decision: "pending_confirm",
			outcome: "expired",
		});
		const [result] = lastToolResults(fake.stepRequests[3]);
		expect(result).toMatchObject({ isError: true });
		expect(result?.body).toMatchObject({ status: "expired" });
	});
});

describe("オーナー以外", () => {
	it("deny の結果が LLM に返り、adapter は呼ばれず保留も作られない", async () => {
		const { stub, fake, calls, ops } = await setup("guest");
		fake.enqueueStep(
			toolUse([{ name: "calendar_create_event", input: createInput }]),
			final("それは私にはできません"),
		);
		const res = await stub.handleDiscordMessage(
			ask("明日19時に歯医者入れて", {
				author: { id: GUEST, displayName: "bob", isBot: false },
			}),
		);

		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "それは私にはできません" }],
		});
		expect(systemText(fake.stepRequests[0])).toContain(
			"- 新着メッセージの発言者: オーナーではない",
		);
		const results = lastToolResults(fake.stepRequests[1]);
		expect(results[0]).toMatchObject({ isError: true });
		expect(results[0]?.body).toEqual({ status: "denied", reason: "not_owner" });
		expect(calls).toHaveLength(0);
		expect(ops.size).toBe(0);
		expect(res.audit.toolCalls).toEqual([
			expect.objectContaining({
				tool: "calendar_create_event",
				decision: "deny",
				outcome: "denied",
				summary: "not_owner",
			}),
		]);
	});
});

describe("ループの上限", () => {
	const listCall = () =>
		toolUse([{ name: "calendar_list_events", input: listInput }]);

	it("往復の上限を超える呼び出しは実行せず、最後の 1 回で答えさせる", async () => {
		const { stub, fake, calls } = await setup("round-limit");
		fake.enqueueStep(
			...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, listCall),
			final("ここまでの結果で答えます"),
		);
		const res = await stub.handleDiscordMessage(ask("予定を全部教えて"));

		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "ここまでの結果で答えます" }],
		});
		expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(res.audit.toolCalls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(fake.stepRequests).toHaveLength(MAX_TOOL_ROUNDS + 2);
		const last = lastToolResults(fake.stepRequests.at(-1));
		expect(last).toHaveLength(1);
		expect(last[0]).toMatchObject({ isError: true });
		expect(last[0]?.body.status).toBe("not_executed");
	});

	it("最後の 1 回でも final にならなければ LLM の失敗として扱い、実行済みの呼び出しは audit に残す", async () => {
		const { stub, fake, calls } = await setup("round-limit-fail");
		fake.enqueueStep(...Array.from({ length: MAX_TOOL_ROUNDS + 2 }, listCall));
		const res = await stub.handleDiscordMessage(ask("予定を全部教えて"));

		expect(res.action).toBe("ignore");
		expect(res.audit).toMatchObject({
			reason: "error",
			degraded: true,
			errorType: "ValidationFailed",
		});
		expect(res.audit.toolCalls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(fake.stepRequests).toHaveLength(MAX_TOOL_ROUNDS + 2);
	});

	it("待ち時間の上限を過ぎたら、次の呼び出しは実行しない", async () => {
		const { stub, fake, calls } = await setup("time-limit", {
			executeCostMs: TOOL_LOOP_TIMEOUT_MS + 1000,
		});
		fake.enqueueStep(listCall(), listCall(), final("時間切れなのでここまで"));
		const res = await stub.handleDiscordMessage(ask("予定を教えて"));

		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "時間切れなのでここまで" }],
		});
		expect(calls).toHaveLength(1);
		expect(fake.stepRequests[0]?.timeoutMs).toBe(TOOL_LOOP_TIMEOUT_MS);
		expect(fake.stepRequests[1]?.timeoutMs).toBeLessThanOrEqual(
			TOOL_LOOP_TIMEOUT_MS,
		);
		expect(lastToolResults(fake.stepRequests[2])[0]?.body.status).toBe(
			"not_executed",
		);
	});
});

describe("LLM の失敗", () => {
	it("道具を実行したあとの step が失敗しても、実行した記録は audit に残る", async () => {
		const { stub, fake, calls } = await setup("step-fail");
		fake.enqueueStep(
			toolUse([{ name: "calendar_list_events", input: listInput }]),
			{ ok: false, error: validationFailed({ issues: ["bad output"] }) },
		);
		const res = await stub.handleDiscordMessage(ask("予定を教えて"));
		expect(res.action).toBe("ignore");
		expect(res.audit).toMatchObject({
			reason: "error",
			degraded: true,
			errorType: "ValidationFailed",
		});
		expect(res.audit.toolCalls).toHaveLength(1);
		expect(calls).toHaveLength(1);
	});
});

describe("添付の読み取り", () => {
	const setupAttachment = async (name: string) => {
		const stub = partnerStub(name);
		const fake = new FakeLLMProvider();
		const calls: CapabilityRequest[] = [];
		const adapter: CapabilityAdapter = {
			tools: [readAttachment],
			execute: async (request) => {
				calls.push(request);
				return ok({
					data: { outcome: "read", kind: "image", filename: "haircut.jpg" },
					images: [{ mediaType: "image/jpeg", data: "QUJD" }],
					summary: "画像の添付を読んだ",
				});
			},
		};
		const registry = createToolRegistry([adapter]);
		if (!registry.ok) throw new Error("登録簿を作れない");
		const pending: PendingStore = {
			listOpen: async () => [],
			get: async () => null,
			save: async () => undefined,
		};
		const gate = createCapabilityGate({
			registry: registry.value,
			policy: { attachment_read: "auto" },
			pending,
			now: () => T0,
		});
		await runInDurableObject(stub, (o) => {
			o.now = () => T0;
			o.createRouter = () => new ModelRouter({ provider: fake });
			o.capabilities = { gate, pending, isOwner: (id) => id === OWNER };
		});
		return { stub, fake, calls };
	};

	it("プロンプトに添付を出し、返信先の id を道具に渡し、画像を tool_results に載せる", async () => {
		const { stub, fake, calls } = await setupAttachment("attachment");
		fake.enqueueStep(
			toolUse([
				{ name: "read_attachment", input: { message: "current", index: 1 } },
			]),
			final("いい髪型ですね"),
		);
		const msg = ask("これ見て", {
			replyToMessageId: "m-reply",
			attachments: [
				{ name: "haircut.jpg", contentType: "image/jpeg", size: 1_258_291 },
			],
		});
		const res = await stub.handleDiscordMessage(msg);

		const first = fake.stepRequests[0];
		const userTurn = first?.messages[0];
		expect(userTurn && "content" in userTurn ? userTurn.content : "").toContain(
			"- 添付1: haircut.jpg（image/jpeg、1.2MB）",
		);
		expect(first?.tools.map((t) => t.name)).toContain("read_attachment");
		expect(calls[0]?.context).toMatchObject({
			sourceMessageId: msg.messageId,
			replyToMessageId: "m-reply",
		});

		const results = lastToolResults(fake.stepRequests[1]);
		expect(results[0]?.images).toEqual([
			{ mediaType: "image/jpeg", data: "QUJD" },
		]);
		expect(results[0]?.content).not.toContain("QUJD");
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "read_attachment",
			decision: "auto",
			outcome: "ok",
			summary: "画像の添付を読んだ",
		});
	});

	it("オーナー以外の依頼では adapter を呼ばない", async () => {
		const { stub, fake, calls } = await setupAttachment("attachment-guest");
		fake.enqueueStep(
			toolUse([
				{ name: "read_attachment", input: { message: "current", index: 1 } },
			]),
			final("すみません、読めません"),
		);
		await stub.handleDiscordMessage(
			ask("これ見て", {
				author: { id: GUEST, displayName: "bob", isBot: false },
			}),
		);
		expect(calls).toHaveLength(0);
		expect(lastToolResults(fake.stepRequests[1])[0]?.images).toBeUndefined();
	});
});
