import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	type CapabilityAdapter,
	calendarListEvents,
	createCapabilityGate,
	createToolRegistry,
	type PendingStore,
} from "@yunomi/capabilities";
import { externalServiceUnavailable, ok } from "@yunomi/core";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { type LangfuseConfig, langfuseConfig } from "../src/langfuse.ts";
import { inbound, partnerStub } from "./helpers.ts";
import { final, meta, toolUse, turnResponse } from "./llm-fixtures.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-10-11T03:00:00Z");

type Sent = { url: string; headers: Headers; body: OtlpBody };
type OtlpAttr = { key: string; value: Record<string, unknown> };
type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttr[];
	status: { code: number; message?: string };
};
type OtlpBody = {
	resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
};

const spansOf = (body: OtlpBody): OtlpSpan[] =>
	body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));

const attr = (span: OtlpSpan | undefined, key: string): unknown => {
	const v = span?.attributes.find((a) => a.key === key)?.value;
	return v ? Object.values(v)[0] : undefined;
};

const config = (
	fetchFn: typeof fetch,
	over: Partial<LangfuseConfig> = {},
): LangfuseConfig => ({
	url: "https://langfuse.example.com",
	publicKey: "pk-lf-test",
	secretKey: "sk-lf-test",
	accessClientId: "access-id.access",
	accessClientSecret: "access-secret",
	environment: "production",
	fetch: fetchFn,
	...over,
});

/** 送られた trace を記録する偽の Langfuse。 */
const fakeLangfuse = (
	respond: () => Promise<Response> = async () => Response.json({}),
) => {
	const sent: Sent[] = [];
	const fetchFn = (async (input, init) => {
		sent.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as OtlpBody,
		});
		return respond();
	}) as typeof fetch;
	return { sent, fetchFn };
};

const setup = async (
	name: string,
	langfuse: LangfuseConfig | null,
	opts: { tools?: boolean } = {},
) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	const pending: PendingStore = {
		listOpen: async () => [],
		get: async () => null,
		save: async () => {},
	};
	const adapter: CapabilityAdapter = {
		tools: [calendarListEvents],
		execute: async () =>
			ok({ data: { events: [], truncated: false }, summary: "予定 0 件" }),
	};
	const registry = createToolRegistry([adapter]);
	if (!registry.ok) throw new Error("登録簿を作れない");
	const gate = createCapabilityGate({
		registry: registry.value,
		policy: { calendar_read: "auto" },
		pending,
		now: () => T0,
	});
	await runInDurableObject(stub, (o) => {
		o.now = () => T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
		o.langfuse = langfuse;
		if (opts.tools) {
			o.capabilities = { gate, pending, isOwner: (id) => id === "u1" };
		}
	});
	const flush = () => runInDurableObject(stub, (o) => o.flushBackground());
	return { stub, fake, flush };
};

const ask = (text = "ゆかりん、こんにちは") =>
	inbound({ mentionedUserIds: [BOT], content: text });

const replyOk = (text: string) => ({
	ok: true as const,
	value: { output: turnResponse(text), ...meta(HAIKU) },
});

describe("Langfuse への trace", () => {
	it("設定が無ければ送らない（テストの env には secret が無い）", async () => {
		const stub = partnerStub("lf-default");
		expect(await runInDurableObject(stub, (o) => o.langfuse)).toBeNull();
		expect(
			langfuseConfig({ LANGFUSE_URL: "https://langfuse.example.com" }),
		).toBeNull();
	});

	it("会話 1 回を root の span 1 つと、LLM の呼び出しごとの generation で送る", async () => {
		const lf = fakeLangfuse();
		const { stub, fake, flush } = await setup("lf-reply", config(lf.fetchFn));
		fake.enqueue({
			ok: true,
			value: {
				output: turnResponse("こんにちは"),
				model: HAIKU,
				usage: {
					inputTokens: 100,
					outputTokens: 20,
					cacheReadTokens: 30,
					cacheWriteTokens: 5,
				},
				latencyMs: 12,
				stopReason: "end_turn",
			},
		});
		const res = await stub.handleDiscordMessage(ask());
		expect(res.action).toBe("reply");
		await flush();

		expect(lf.sent).toHaveLength(1);
		const req = lf.sent[0];
		expect(req?.url).toBe(
			"https://langfuse.example.com/api/public/otel/v1/traces",
		);
		expect(req?.headers.get("authorization")).toBe(
			`Basic ${btoa("pk-lf-test:sk-lf-test")}`,
		);
		expect(req?.headers.get("cf-access-client-id")).toBe("access-id.access");
		expect(req?.headers.get("cf-access-client-secret")).toBe("access-secret");
		expect(req?.headers.get("x-langfuse-ingestion-version")).toBe("4");
		expect(req?.headers.get("content-type")).toBe("application/json");

		const spans = spansOf(req?.body as OtlpBody);
		const root = spans.find((s) => s.parentSpanId === undefined);
		const gens = spans.filter((s) => s.parentSpanId !== undefined);
		expect(spans.filter((s) => s.parentSpanId === undefined)).toHaveLength(1);
		expect(gens).toHaveLength(1);
		expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(root?.spanId).toMatch(/^[0-9a-f]{16}$/);
		expect(root?.startTimeUnixNano).toMatch(/^\d+$/);
		expect(attr(root, "langfuse.observation.type")).toBe("span");
		expect(
			JSON.parse(String(attr(root, "langfuse.observation.input"))),
		).toMatchObject({
			speaker: "alice",
			text: "ゆかりん、こんにちは",
		});
		expect(
			JSON.parse(String(attr(root, "langfuse.observation.output"))),
		).toEqual({
			decision: "reply",
			reason: "llm",
			messages: ["こんにちは"],
		});

		const gen = gens[0];
		expect(gen?.traceId).toBe(root?.traceId);
		expect(gen?.parentSpanId).toBe(root?.spanId);
		expect(gen?.name).toBe("turn_response");
		expect(gen?.endTimeUnixNano).toMatch(/^\d+$/);
		expect(attr(gen, "langfuse.observation.type")).toBe("generation");
		expect(attr(gen, "langfuse.observation.model.name")).toBe(HAIKU);
		expect(
			JSON.parse(String(attr(gen, "langfuse.observation.usage_details"))),
		).toEqual({
			input: 100,
			output: 20,
			cache_read_input_tokens: 30,
			cache_creation_input_tokens: 5,
		});
		const input = JSON.parse(String(attr(gen, "langfuse.observation.input")));
		expect(input.system.length).toBeGreaterThan(0);
		expect(JSON.stringify(input.messages)).toContain("ゆかりん、こんにちは");
		expect(
			JSON.parse(String(attr(gen, "langfuse.observation.output"))),
		).toMatchObject({
			messages: ["こんにちは"],
		});
		for (const span of spans) {
			expect(attr(span, "langfuse.environment")).toBe("production");
			expect(attr(span, "langfuse.trace.name")).toBe("yukarin.turn");
			expect(attr(span, "langfuse.session.id")).toBe("yukarin:c1");
			expect(attr(span, "langfuse.user.id")).toBe("u1");
		}
	});

	it("道具のループは、往復ごとの generation を同じ trace に並べる", async () => {
		const lf = fakeLangfuse();
		const { stub, fake, flush } = await setup("lf-tools", config(lf.fetchFn), {
			tools: true,
		});
		fake.enqueueStep(
			toolUse([
				{
					name: "calendar_list_events",
					input: {
						from: "2026-10-12T00:00:00+09:00",
						to: "2026-10-13T00:00:00+09:00",
					},
				},
			]),
			final("予定はないよ"),
		);
		const res = await stub.handleDiscordMessage(ask("明日の予定は？"));
		expect(res.action).toBe("reply");
		await flush();

		const spans = spansOf(lf.sent[0]?.body as OtlpBody);
		const gens = spans.filter((s) => s.parentSpanId !== undefined);
		expect(gens.map((g) => g.name)).toEqual([
			"turn_response.step",
			"turn_response.step",
		]);
		expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
		expect(
			JSON.parse(String(attr(gens[0], "langfuse.observation.output"))),
		).toMatchObject({
			tool_calls: [{ name: "calendar_list_events" }],
		});
		const second = JSON.parse(
			String(attr(gens[1], "langfuse.observation.input")),
		);
		expect(second.messages.at(-1)).toMatchObject({ role: "tool" });
		expect(second.tools).toContain("calendar_list_events");
	});

	it("LLM の失敗は ERROR の generation として送る", async () => {
		const lf = fakeLangfuse();
		const { stub, fake, flush } = await setup(
			"lf-llm-fail",
			config(lf.fetchFn),
		);
		const down = {
			ok: false as const,
			error: {
				...externalServiceUnavailable({ service: "anthropic" }),
				retryable: false,
			},
		};
		fake.enqueue(down);
		await stub.handleDiscordMessage(ask());
		await flush();

		const gens = spansOf(lf.sent[0]?.body as OtlpBody).filter(
			(s) => s.parentSpanId !== undefined,
		);
		expect(gens).toHaveLength(1);
		expect(attr(gens[0], "langfuse.observation.level")).toBe("ERROR");
		expect(
			String(attr(gens[0], "langfuse.observation.status_message")),
		).toContain("ExternalServiceUnavailable");
		expect(gens[0]?.status.code).toBe(2);
	});

	it("LLM を呼ばなかったターンは送らない", async () => {
		const lf = fakeLangfuse();
		const { stub, flush } = await setup("lf-bot", config(lf.fetchFn));
		const res = await stub.handleDiscordMessage(
			inbound({ author: { id: "b1", displayName: "bot", isBot: true } }),
		);
		expect(res.action).toBe("ignore");
		await flush();
		expect(lf.sent).toHaveLength(0);
	});

	const failures: [string, () => Promise<Response>][] = [
		[
			"通信が失敗する",
			async () => Promise.reject(new TypeError("network down")),
		],
		["500 を返す", async () => new Response("boom", { status: 500 })],
		[
			"Access が login へ redirect する",
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://example.com/login" },
				}),
		],
	];
	for (const [label, respond] of failures) {
		it(`Langfuse が${label}ときも、会話の結果は変わらない`, async () => {
			const lf = fakeLangfuse(respond);
			const { stub, fake, flush } = await setup(
				`lf-fail-${label}`,
				config(lf.fetchFn),
			);
			fake.enqueue(replyOk("こんにちは"));
			const res = await stub.handleDiscordMessage(ask());
			expect(res).toMatchObject({
				action: "reply",
				messages: [{ content: "こんにちは" }],
			});
			await flush();
			expect(lf.sent).toHaveLength(1);
		});
	}

	it("Langfuse が応答しなければ、タイムアウトで諦める", async () => {
		const sent: unknown[] = [];
		const hang = ((_input, init) => {
			sent.push(init);
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			});
		}) as typeof fetch;
		const { stub, fake, flush } = await setup(
			"lf-hang",
			config(hang, { timeoutMs: 20 }),
		);
		fake.enqueue(replyOk("こんにちは"));
		const res = await stub.handleDiscordMessage(ask());
		expect(res.action).toBe("reply");
		await flush();
		expect(sent).toHaveLength(1);
	});
});
