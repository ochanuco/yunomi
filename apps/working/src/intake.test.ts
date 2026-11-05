import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ok } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import { openApprovalStore } from "./approval-store.ts";
import {
	type ChimeraImages,
	createAttachmentCollector,
} from "./attachments.ts";
import { grantPathOf, guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import {
	backgroundRunning,
	createIntake,
	type IntakeDeps,
	isRestartRequest,
	seatStartFailedText,
} from "./intake.ts";
import { silentLogger } from "./logger.ts";
import { openSeatStore } from "./seat-store.ts";
import {
	BOT,
	envelope,
	FORUM,
	fakeDiscord,
	fakeOrca,
	OWNER,
	say,
	seatMessage,
	TEXT,
	tempDir,
} from "./test-support.ts";

const T0 = new Date("2026-11-05T08:00:00Z");
const PREAMBLE = "【人格】\n## 仕事のしかた\n【引き継ぎの指示】";

const setup = async (
	opts: {
		seatLimit?: number;
		stateDir?: string;
		orca?: ReturnType<typeof fakeOrca>;
		seatsDir?: string;
		chimera?: ChimeraImages;
	} = {},
) => {
	const stateDir = opts.stateDir ?? tempDir();
	const d = fakeDiscord();
	const o = opts.orca ?? fakeOrca(opts.seatsDir);
	let clock = T0.getTime();
	const remembered: string[] = [];
	const standup: { text: string; blocked: number }[] = [];
	const seats = await openSeatStore(stateDir);
	const ledger = createLedger(guardDirOf(stateDir));
	let g = 0;
	const deps: IntakeDeps = {
		discord: d.api,
		orca: o.orca,
		seats,
		approvals: await openApprovalStore(stateDir),
		ledger,
		summarize: vi.fn(async () => ok("請求書の整理")),
		collectAttachments: createAttachmentCollector({
			chimera: opts.chimera ?? null,
			logger: silentLogger,
		}),
		remember: async (s) => {
			remembered.push(s);
		},
		standupDone: async (text, blocked) => {
			standup.push({ text, blocked: blocked.length });
		},
		preamble: PREAMBLE,
		botUserId: BOT,
		ownerUserIds: new Set([OWNER]),
		workTextChannelId: TEXT,
		workForumChannelId: FORUM,
		seatLimit: opts.seatLimit ?? 6,
		sleepAfterMs: 2 * 60 * 60_000,
		newGrantId: () => `g${++g}`,
		now: () => new Date(clock),
		logger: silentLogger,
	};
	return {
		d,
		o,
		seats,
		ledger,
		stateDir,
		remembered,
		standup,
		intake: createIntake(deps),
		advance: (ms: number) => {
			clock += ms;
		},
	};
};

/** 人が仕事フォーラムに直接投稿し、席ができたところまで進める。 */
const openPost = async (
	s: Awaited<ReturnType<typeof setup>>,
	threadId = "p1",
	content = "README の誤字を直して",
) => {
	s.d.addThread(threadId, "README の誤字");
	await s.intake.handle(say(threadId, content, { first: true }));
	const seat = s.seats.get(threadId);
	if (!seat?.dispatchId) throw new Error("seat not started");
	return seat;
};

describe("新しい投稿", () => {
	it("仕事チャンネルの依頼から投稿を立て、席を作って依頼を渡し、タグを作業中にする", async () => {
		const s = await setup();
		await s.intake.handle(envelope({}));

		expect(s.d.posts[0]).toEqual(
			expect.objectContaining({
				name: "請求書の整理",
				tagIds: ["tag-working"],
			}),
		);
		expect(s.d.sentTo(TEXT)[0]).toContain("フォーラムに立てました");
		const [start] = s.o.opsOf("startSeat") as {
			name: string;
			spec: string;
		}[];
		expect(start?.name).toBe("seat-thread1");
		// spec は人格・仕事のしかた・引き継ぎの指示の前置きに、依頼を続ける
		expect(start?.spec.startsWith(PREAMBLE)).toBe(true);
		expect(start?.spec).toContain("請求書を整理して");
		expect(s.seats.get("thread1")?.status).toBe("working");
		expect(s.d.tagsOf("thread1")).toEqual(["tag-working"]);
	});

	it("人が直接立てた投稿でも席を作る", async () => {
		const s = await setup();
		const seat = await openPost(s);
		expect(seat.path).toBe("/seats/seat-p1");
		const [start] = s.o.opsOf("startSeat") as { spec: string }[];
		expect(start?.spec).toContain("README の誤字を直して");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("持ち主以外の人とほかの bot の発言では席を作らない", async () => {
		const s = await setup();
		s.d.addThread("p1", "x");
		await s.intake.handle(
			envelope({
				channel_id: "p1",
				message_id: "p1",
				author: { id: "other", display_name: "誰か", is_bot: false },
			}),
		);
		await s.intake.handle(
			envelope({ author: { id: OWNER, display_name: "bot", is_bot: true } }),
		);
		expect(s.o.opsOf("startSeat")).toEqual([]);
		expect(s.d.posts).toEqual([]);
	});

	it("席の数が上限なら順番待ちと書いて待たせ、空いたら始める", async () => {
		const s = await setup({ seatLimit: 1 });
		const first = await openPost(s, "p1");
		s.d.addThread("p2", "二つ目");
		await s.intake.handle(say("p2", "二つ目の依頼", { first: true }));
		expect(s.seats.get("p2")?.status).toBe("queued");
		expect(s.d.sentTo("p2")[0]).toContain("順番待ち");
		await s.intake.handle(say("p2", "追加でこれも"));

		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: first.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		await vi.waitFor(() => expect(s.seats.get("p2")?.status).toBe("working"));
		const starts = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(starts[1]?.name).toBe("seat-p2");
		expect(starts[1]?.spec).toContain("二つ目の依頼");
		expect(starts[1]?.spec).toContain("追加でこれも");
	});
});

describe("投稿への返事", () => {
	it("作業中の席には send で渡し、続きの Dispatch を覚える", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.handle(say("p1", "ついでに CHANGELOG も"));
		const [send] = s.o.opsOf("send") as { dispatchId: string; body: string }[];
		expect(send?.dispatchId).toBe(seat.dispatchId);
		expect(send?.body).toContain("ちゃぬ: ついでに CHANGELOG も");
		const after = s.seats.get("p1");
		expect(after?.dispatchIds).toHaveLength(2);
		expect(after?.dispatchId).not.toBe(seat.dispatchId);
	});

	it("受付を作り直しても、volume の対応表から同じ席に渡す", async () => {
		const stateDir = tempDir();
		const orca = fakeOrca();
		const first = await setup({ stateDir, orca });
		const seat = await openPost(first);

		const again = await setup({ stateDir, orca });
		again.d.addThread("p1", "README の誤字");
		await again.intake.handle(say("p1", "まだですか"));
		const sends = orca.opsOf("send") as { dispatchId: string }[];
		expect(sends.at(-1)?.dispatchId).toBe(seat.dispatchId);
		expect(orca.opsOf("startSeat")).toHaveLength(1);
	});
});

describe("席の質問", () => {
	it("投稿に書いてタグを決めてほしいにし、返事を答えとして返す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		const q = seatMessage({
			type: "question",
			dispatchId: seat.dispatchId,
			body: "どのブランチに push しますか？",
		});
		await s.intake.onSeatMessage(q);
		expect(s.d.sentTo("p1").at(-1)).toBe("どのブランチに push しますか？");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("asking");

		// ask のあとターンを終えた知らせは投稿に出さない
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: "端末の出力",
			}),
		);
		expect(s.d.sentTo("p1")).toHaveLength(1);

		await s.intake.handle(say("p1", "dev/typo で"));
		expect(s.o.opsOf("reply")).toEqual([
			{ messageId: q.id, body: expect.stringContaining("dev/typo で") },
		]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("報告せずに止まった席は、止まったと書いて決めてほしいにし、次の返事は send で渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: "端末の出力",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toContain("途中で止まりました");
		expect(s.d.sentTo("p1").join()).not.toContain("端末の出力");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		await s.intake.handle(say("p1", "続けて"));
		expect(s.o.opsOf("send")).toHaveLength(1);
	});
});

describe("取り消せない操作で止まったとき", () => {
	it("止めた操作を質問に書き添え、OK で席の hook に 1 回だけの許可を渡し、次の報告で使わなかった許可を失効させる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		const op = { tool: "Bash", target: "gh pr merge 3" };
		s.ledger.addPending("p1", { operation: op, reason: "gh pr merge は…" });
		const q = seatMessage({
			type: "question",
			dispatchId: seat.dispatchId,
			body: "PR をマージしてよいですか",
		});
		await s.intake.onSeatMessage(q);
		const asked = s.d.sentTo("p1").at(-1) ?? "";
		expect(asked).toContain("PR をマージしてよいですか");
		expect(asked).toContain("決めてほしいこと");
		expect(asked).toContain("gh pr merge 3");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);

		await s.intake.handle(say("p1", "OK"));
		const grantPath = grantPathOf(guardDirOf(s.stateDir), "p1");
		expect(JSON.parse(readFileSync(grantPath, "utf8"))).toEqual({
			grant_id: "g1",
			operations: [op],
		});
		const [reply] = s.o.opsOf("reply") as { body: string }[];
		expect(reply?.body).toContain("1 回だけ許可した");

		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "マージしました\n状態: 完了",
			}),
		);
		expect(existsSync(grantPath)).toBe(false);
		const events = readFileSync(
			join(guardDirOf(s.stateDir), "log.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);
		expect(events).toEqual(["requested", "granted", "expired"]);
	});

	it("決まった言い方以外の返事なら許可せず、返事としてそのまま渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		s.ledger.addPending("p1", {
			operation: { tool: "Bash", target: "git push origin main" },
			reason: "main への push",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "push してよい？",
			}),
		);
		await s.intake.handle(say("p1", "いや、dev/ にして"));
		expect(existsSync(grantPathOf(guardDirOf(s.stateDir), "p1"))).toBe(false);
		const [reply] = s.o.opsOf("reply") as { body: string }[];
		expect(reply?.body).toContain("いや、dev/ にして");
		expect(reply?.body).not.toContain("許可した");
	});

	it("止めた操作を残したまま報告してきたら、完了にせず許可を待つ", async () => {
		const s = await setup();
		const seat = await openPost(s);
		s.ledger.addPending("p1", {
			operation: { tool: "Bash", target: "wrangler deploy" },
			reason: "デプロイ",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "デプロイ以外は済みました\n状態: 完了",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toContain("wrangler deploy");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("waiting");
		expect(s.o.opsOf("removeWorktree")).toEqual([]);
	});
});

describe("席の完了報告", () => {
	it("投稿に書いてタグを完了にし、記憶に 1 行残し、席を閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直して PR を出しました\n状態: 完了",
				outcome: "succeeded",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toBe("直して PR を出しました");
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
		expect(s.remembered).toEqual(["仕事フォーラムの「README の誤字」を終えた"]);
		expect(s.o.opsOf("stopSeat")).toEqual([
			expect.objectContaining({
				dispatchId: seat.dispatchId,
				terminal: seat.terminal,
			}),
		]);
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.o.live.has(seat.terminal ?? "")).toBe(false);
		expect(s.seats.get("p1")).toBeNull();
	});

	it("Mac でやる必要があれば、タグを引き継ぎにして席を閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "申し送りを書きました https://github.com/o/r/issues/9\n状態: 引き継ぎ",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
		expect(s.remembered[0]).toContain("Mac に引き継いだ");
		expect(s.seats.get("p1")).toBeNull();
	});

	it("決めてほしいで終えたら席を残し、次の返事を続きとして渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "A と B のどちらにしますか\n状態: 決めてほしい",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("waiting");
		await s.intake.handle(say("p1", "A で"));
		expect(s.o.opsOf("send")).toHaveLength(1);
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("完了のあとにまた書くと、同じ投稿に新しい席を作ってこれまでのやりとりを渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		s.d.history.set("p1", [
			{
				id: "p1",
				authorId: OWNER,
				authorName: "ちゃぬ",
				isBot: false,
				content: "README の誤字を直して",
			},
			{
				id: "b1",
				authorId: BOT,
				authorName: "Yukarin",
				isBot: true,
				content: "直しました",
			},
			{
				id: "m9",
				authorId: OWNER,
				authorName: "ちゃぬ",
				isBot: false,
				content: "もう一か所あった",
			},
		]);
		await s.intake.handle(say("p1", "もう一か所あった"));
		const starts = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(starts).toHaveLength(2);
		expect(starts[1]?.name).toBe("seat-p1");
		expect(starts[1]?.spec.startsWith(PREAMBLE)).toBe(true);
		expect(starts[1]?.spec).toContain("[あなた] 直しました");
		expect(starts[1]?.spec).toContain("[ちゃぬ] もう一か所あった");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});
});

describe("決めてほしいまま時間がたった席", () => {
	it("Claude だけ止め、返事が来たら前の会話のまま起こす", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		s.advance(60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toEqual([]);

		s.advance(60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toHaveLength(1);
		expect(s.o.opsOf("removeWorktree")).toEqual([]);
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		expect(s.o.live.has(seat.terminal ?? "")).toBe(false);

		await s.intake.handle(say("p1", "B で"));
		const [resume] = s.o.opsOf("resumeSeat") as {
			path: string;
			spec: string;
		}[];
		expect(resume?.path).toBe("/seats/seat-p1");
		expect(resume?.spec).toContain("「どちらにしますか」");
		expect(resume?.spec).toContain("ちゃぬ: B で");
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("止めた席は上限に数えない", async () => {
		const s = await setup({ seatLimit: 1 });
		const seat = await openPost(s, "p1");
		await s.intake.onSeatMessage(
			seatMessage({ type: "question", dispatchId: seat.dispatchId, body: "?" }),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		await openPost(s, "p2");
		expect(s.seats.get("p2")?.status).toBe("working");
	});
});

describe("起動時の突き合わせ", () => {
	it("対応表に無い席の端末と worktree は片付け、対応表にある席は残す", async () => {
		const orca = fakeOrca();
		const s = await setup({ orca });
		const seat = await openPost(s);
		orca.worktrees.add("/seats/seat-old");
		orca.strayTerminals.push(
			{ handle: "t-old", path: "/seats/seat-old" },
			{ handle: seat.terminal ?? "", path: "/seats/seat-p1" },
			{ handle: "t-extra", path: "/seats/seat-p1" },
		);
		await s.intake.reconcile();
		expect(orca.opsOf("closeTerminal")).toEqual(["t-old", "t-extra"]);
		expect(orca.opsOf("removeWorktree")).toEqual(["/seats/seat-old"]);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("Claude がいなくなった席は止めた扱いにし、作業中だったなら投稿で知らせる", async () => {
		const orca = fakeOrca();
		const s = await setup({ orca });
		const seat = await openPost(s);
		orca.live.delete(seat.terminal ?? "");
		await s.intake.reconcile();
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		expect(s.d.sentTo("p1").at(-1)).toContain("受付を作り直した");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		await s.intake.handle(say("p1", "続けて"));
		expect(orca.opsOf("resumeSeat")).toHaveLength(1);
	});
});

describe("朝会の席", () => {
	it("朝会の席は聞かせず、報告を決めてほしいことに回して席を閉じる", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("朝会の spec");
		const seat = s.seats.get(id);
		expect(seat?.standup).toBe(true);
		const [start] = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(start?.name).toBe(`seat-${id}`);

		const q = seatMessage({
			type: "question",
			dispatchId: seat?.dispatchId ?? null,
			body: "?",
		});
		await s.intake.onSeatMessage(q);
		expect(s.o.opsOf("reply")).toEqual([
			{
				messageId: q.id,
				body: expect.stringContaining("朝会では持ち主に聞けない"),
			},
		]);

		s.ledger.addPending(id, {
			operation: { tool: "Bash", target: "gh pr merge 1" },
			reason: "merge",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat?.dispatchId ?? null,
				body: "```json\n{}\n```",
			}),
		);
		expect(s.standup).toEqual([{ text: "```json\n{}\n```", blocked: 1 }]);
		expect(s.seats.get(id)).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual([`/seats/seat-${id}`]);
	});
});

describe("席を始められなかったとき", () => {
	it("止まった所が分かる短い文を投稿に書き、Orca の理由の文は出さない", async () => {
		const orca = fakeOrca();
		vi.mocked(orca.orca.startSeat).mockResolvedValueOnce({
			ok: false,
			error: {
				type: "OrcaFailed",
				command: "orchestration worker-start",
				reason:
					"Error: start_failed: agent_readiness: Agent startup blocked: agent-trust-workspace /home/worker/x",
			},
		});
		const s = await setup({ orca });
		s.d.addThread("p1", "x");
		await s.intake.handle(say("p1", "頼みます", { first: true }));
		expect(s.d.sentTo("p1")).toEqual([
			"席を始められませんでした（Claude の作業場所の確認で止まった）。返事をくれれば、もう一度始めます。",
		]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
	});

	it("理由ごとに文を分ける", () => {
		const of = (type: "OrcaFailed" | "SeatTrustFailed", reason: string) =>
			seatStartFailedText({ type, command: "c", reason });
		expect(of("SeatTrustFailed", "lock")).toContain(
			"Claude の作業場所を信頼済みにできなかった",
		);
		expect(
			of("OrcaFailed", "start_failed: agent_readiness: timeout"),
		).toContain("Claude が起動しきらなかった");
		expect(of("OrcaFailed", "selector_not_found")).toContain(
			"Orca が席を作れなかった",
		);
	});
});

describe("裏の作業を待つ席", () => {
	const tail = (footer: string) =>
		`Worker t1 ended its turn without sending worker_done.\nLast output:\n● バックグラウンドで回しました。終わるまで待ちます。\n${footer}`;

	it("裏の shell を残してターンを終えた知らせは、止まったと書かない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("✻ Worked for 7s · done 2:06 PM · 1 shell still running"),
			}),
		);
		expect(s.d.sentTo("p1")).toEqual([]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("裏の作業を待つ間の書き込みには、最後の途中経過を添えて作業中と即答し、席にも渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "描画を待っています。\n5 分ほどです。",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("✻ done · 1 shell still running"),
			}),
		);
		await s.intake.handle(say("p1", "止まってない？"));
		expect(s.d.sentTo("p1").at(-1)).toBe(
			"作業中です。（描画を待っています。 5 分ほどです。）",
		);
		const [sent] = s.o.opsOf("send") as { body: string }[];
		expect(sent?.body).toContain("手が空いたら status で答え");
		expect(sent?.body).toContain("止まってない？");
		// 席が答えるまでの次の書き込みにも即答する
		await s.intake.handle(say("p1", "まだ？"));
		expect(s.d.sentTo("p1").at(-1)).toBe(
			"作業中です。（描画を待っています。 5 分ほどです。）",
		);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("途中経過が無ければ、いまやっていることは省く。席が報告したら即答はやめる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("· 2 shells ·"),
			}),
		);
		await s.intake.handle(say("p1", "どう？"));
		expect(s.d.sentTo("p1")).toEqual(["作業中です。"]);
		const current = s.seats.get("p1");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: current?.dispatchId ?? null,
				body: "A と B のどちらにしますか",
			}),
		);
		await s.intake.handle(say("p1", "A で"));
		expect(s.d.sentTo("p1")).toEqual([
			"作業中です。",
			"A と B のどちらにしますか",
		]);
	});

	it("裏の作業を待っていない席には即答しない", async () => {
		const s = await setup();
		await openPost(s);
		await s.intake.handle(say("p1", "ついでに C も"));
		expect(s.d.sentTo("p1")).toEqual([]);
		expect(s.o.opsOf("send")).toHaveLength(1);
	});

	it("裏の作業が残っているかを端末の末尾から見分ける", () => {
		expect(backgroundRunning(tail("✻ done · 1 shell still running"))).toBe(
			true,
		);
		expect(
			backgroundRunning(tail("⏵⏵ auto mode on · 2 shells · ↓ to manage")),
		).toBe(true);
		expect(backgroundRunning(tail("✻ Worked for 9s · done 10:41 AM"))).toBe(
			false,
		);
	});
});

describe("途中経過", () => {
	it("席の status は、完了を待たずにそのまま投稿に書き、状態とタグは変えない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "描画を待っています。5 分ほどです。",
			}),
		);
		// Dispatch を付けずに送られても、送り手の端末から席を引く
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: null,
				from: seat.terminal ?? "",
				body: "止まってはいません。描き終わったら続けます。",
			}),
		);
		expect(s.d.sentTo("p1")).toEqual([
			"描画を待っています。5 分ほどです。",
			"止まってはいません。描き終わったら続けます。",
		]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});
});

describe("起動し直して", () => {
	it("席の Claude を止めて、同じ worktree で前の会話のまま起こす", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どれにしますか",
			}),
		);
		await s.intake.handle(say("p1", "起動し直して"));
		expect(s.o.opsOf("stopSeat")).toEqual([
			expect.objectContaining({ terminal: seat.terminal }),
		]);
		const [resume] = s.o.opsOf("resumeSeat") as {
			path: string;
			spec: string;
		}[];
		expect(resume?.path).toBe("/seats/seat-p1");
		expect(resume?.spec).toContain("起動し直した");
		expect(resume?.spec).toContain("「どれにしますか」");
		expect(s.o.opsOf("send")).toEqual([]);
		expect(s.o.opsOf("reply")).toEqual([]);
		expect(s.d.sentTo("p1").at(-1)).toContain("起動し直します");
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("決まった言い方だけを起動し直す頼みとみなす", () => {
		for (const t of [
			"起動し直して",
			"起動しなおして。",
			"再起動して",
			"<@1> 再起動",
			"起動し直してください",
		]) {
			expect(isRestartRequest(t), t).toBe(true);
		}
		for (const t of ["起動し直してから A をやって", "再起動しないで", "OK"]) {
			expect(isRestartRequest(t), t).toBe(false);
		}
	});

	it("席が無い投稿では、ふつうの返事として新しい席を作る", async () => {
		const s = await setup();
		s.d.addThread("p9", "x");
		await s.intake.handle(say("p9", "起動し直して"));
		expect(s.o.opsOf("stopSeat")).toEqual([]);
		expect(s.o.opsOf("startSeat")).toHaveLength(1);
	});
});

describe("席の返事の添付", () => {
	const seatWithOut = async (chimera?: ChimeraImages) => {
		const root = tempDir();
		const s = await setup({ seatsDir: root, ...(chimera ? { chimera } : {}) });
		const seat = await openPost(s);
		const out = join(seat.path ?? "", "out");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "shot.png"), "png");
		writeFileSync(join(root, "secret.txt"), "secret");
		symlinkSync(join(root, "secret.txt"), join(out, "link.txt"));
		return { s, seat };
	};

	it("worker_done の添付の行を本文から外して投稿に付け、状態の行も読む", async () => {
		const { s, seat } = await seatWithOut();
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				outcome: "succeeded",
				body: "直しました。\n添付: out/shot.png\n状態: 完了\n添付: out/link.txt",
			}),
		);
		expect(s.d.sent.filter((m) => m.channelId === "p1")).toEqual([
			{
				channelId: "p1",
				content:
					"直しました。\n\n添付できなかったもの:\n- out/link.txt（out/ の外を指している）",
				files: ["shot.png"],
			},
		]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});

	it("ask と status の添付も付け、chimera の行は chimera から取って付ける", async () => {
		const chimera = vi.fn(async (id: string) =>
			ok({
				name: `${id}.png`,
				contentType: "image/png",
				data: new Uint8Array([1]),
			}),
		);
		const { s, seat } = await seatWithOut(chimera);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "1 枚目です。\nchimera: abc123",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか\nchimera: abc123\n添付: out/shot.png\n添付: ../secret.txt",
			}),
		);
		const posted = s.d.sent.filter((m) => m.channelId === "p1");
		expect(posted[0]).toEqual({
			channelId: "p1",
			content: "1 枚目です。",
			files: ["abc123.png"],
		});
		expect(posted[1]?.content).toBe(
			"どちらにしますか\n\n添付できなかったもの:\n- ../secret.txt（out/ の外のパス）",
		);
		expect(posted[1]?.files).toEqual(["abc123.png", "shot.png"]);
		// 席が覚える質問は添付の行を外した本文
		expect(s.seats.get("p1")?.question).toBe(posted[1]?.content);
		expect(chimera).toHaveBeenCalledTimes(2);
	});
});
