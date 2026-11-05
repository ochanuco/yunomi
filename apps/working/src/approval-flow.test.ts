import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ok } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import { openApprovalStore } from "./approval-store.ts";
import { GUARD_ENV, guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { createIntake } from "./intake.ts";
import { silentLogger } from "./logger.ts";
import { openSeatStore } from "./seat-store.ts";
import {
	BOT,
	FORUM,
	fakeDiscord,
	fakeOrca,
	OWNER,
	say,
	seatMessage,
	TEXT,
	tempDir,
} from "./test-support.ts";

const HOOK = join(import.meta.dirname, "guard", "hook.ts");

/**
 * 席の Claude から呼ばれる形で本物の PreToolUse hook（src/guard/hook.ts）を動かす。
 * 席の Claude は orca serve の環境変数を受け継ぎ、Claude CLI は hook に席の場所（CLAUDE_PROJECT_DIR）を渡す。
 */
const setup = async () => {
	const root = tempDir();
	const stateDir = join(root, "state");
	const seatsDir = join(root, "seats");
	const d = fakeDiscord();
	const o = fakeOrca(seatsDir);
	const seats = await openSeatStore(stateDir);
	const intake = createIntake({
		discord: d.api,
		orca: o.orca,
		seats,
		approvals: await openApprovalStore(stateDir),
		ledger: createLedger(guardDirOf(stateDir)),
		summarize: async () => ok("件名"),
		remember: async () => {},
		standupDone: async () => {},
		preamble: "",
		botUserId: BOT,
		ownerUserIds: new Set([OWNER]),
		workTextChannelId: TEXT,
		workForumChannelId: FORUM,
		seatLimit: 6,
		sleepAfterMs: 60_000,
		newGrantId: () => "g1",
		logger: silentLogger,
	});
	const runHook = (threadId: string, input: Record<string, unknown>) => {
		const seatDir = join(seatsDir, `seat-${threadId}`);
		return spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ ...input, cwd: seatDir }),
			env: {
				PATH: process.env.PATH ?? "",
				HOME: join(root, "home"),
				[GUARD_ENV.stateDir]: stateDir,
				[GUARD_ENV.seatsDir]: seatsDir,
				CLAUDE_PROJECT_DIR: seatDir,
			},
			encoding: "utf8",
		});
	};
	/** PreToolUse の答え。hook が何も返さなければ auto モードに任せる（pass）。 */
	const tool = (
		threadId: string,
		tool_name: string,
		tool_input: Record<string, unknown>,
	) => {
		const r = runHook(threadId, {
			hook_event_name: "PreToolUse",
			tool_name,
			tool_input,
		});
		if (r.status !== 0) return "error";
		if (r.stdout.trim() === "") return "pass";
		return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision as string;
	};
	/** auto モードが止めたときに Claude CLI が呼ぶ PermissionDenied。 */
	const denied = (
		threadId: string,
		tool_name: string,
		tool_input: Record<string, unknown>,
	) =>
		runHook(threadId, {
			hook_event_name: "PermissionDenied",
			tool_name,
			tool_input,
			tool_use_id: "u1",
			reason: "main への push は持ち主の確認が要る",
		}).status;
	const bash = (threadId: string, command: string) =>
		tool(threadId, "Bash", { command });
	const open = async (threadId: string) => {
		d.addThread(threadId, threadId);
		await intake.handle(say(threadId, "頼みます", { first: true }));
		return seats.get(threadId);
	};
	return { d, o, seats, intake, root, seatsDir, bash, tool, denied, open };
};

describe("席の Claude の操作と hook", () => {
	it("秘密に触らない操作は hook では決めず、auto モードに任せる", async () => {
		const s = await setup();
		await s.open("p1");
		for (const [name, input] of [
			["Bash", { command: "git push -u origin HEAD:dev/x" }],
			["Bash", { command: 'orca orchestration ask --question "どうしますか"' }],
			["ToolSearch", { query: "chimera", max_results: 5 }],
			["mcp__claude_ai_chimera__create_request", { recipe: "x" }],
			["mcp__claude_ai_chimera__list_catalog", {}],
			["mcp__claude_ai_Gmail__search_threads", { query: "x" }],
			["Write", { file_path: join(s.seatsDir, "seat-p1", "a.ts") }],
		] as const) {
			expect(s.tool("p1", name, input), name).toBe("pass");
		}
	});

	it("秘密情報の読み出しと、許可の記録の書き換えは hook で止める", async () => {
		const s = await setup();
		await s.open("p1");
		expect(s.bash("p1", "printenv")).toBe("deny");
		expect(s.bash("p1", "cat ~/.claude/.credentials.json")).toBe("deny");
		expect(
			s.tool("p1", "Write", {
				file_path: join(s.root, "state", "guard", "grants", "p1.json"),
			}),
		).toBe("deny");
	});

	it("auto モードが止めた操作を投稿で聞き、許可の後に同じ操作を 1 回だけ通す。キーの順が違っても同じ操作で、ほかの投稿の席には効かない", async () => {
		const s = await setup();
		const seat = await s.open("p1");
		await s.open("p2");
		const input = { command: "git push origin HEAD:main", description: "push" };
		expect(s.denied("p1", "Bash", input)).toBe(0);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat?.dispatchId ?? null,
				body: "main に push してよいですか",
			}),
		);
		const asked = s.d.sentTo("p1").at(-1) ?? "";
		expect(asked).toContain("main に push してよいですか");
		expect(asked).toContain("git push origin HEAD:main");
		expect(asked).toContain("auto モードが止めた");

		await s.intake.handle(say("p1", "許可"));
		expect(s.bash("p2", "git push origin HEAD:main")).toBe("pass");
		expect(s.bash("p1", "git push origin HEAD:main")).toBe("allow");
		expect(s.bash("p1", "git push origin HEAD:main")).toBe("pass");
	});

	it("Bash 以外の道具も、許可は引数のキーの順によらず 1 回だけ効く", async () => {
		const s = await setup();
		const seat = await s.open("p1");
		const input = {
			to: "a@example.com",
			subject: "見積もり",
			body: "送ります",
		};
		s.denied("p1", "mcp__claude_ai_Gmail__send_message", input);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat?.dispatchId ?? null,
				body: "メールを送ってよいですか",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toContain(
			"mcp__claude_ai_Gmail__send_message",
		);
		await s.intake.handle(say("p1", "OK"));
		const reordered = {
			body: "送ります",
			subject: "見積もり",
			to: "a@example.com",
		};
		expect(s.tool("p1", "mcp__claude_ai_Gmail__send_message", reordered)).toBe(
			"allow",
		);
		expect(s.tool("p1", "mcp__claude_ai_Gmail__send_message", input)).toBe(
			"pass",
		);
	});

	it("hook が止めた秘密の読み出しも、許可の後に 1 回だけ通す", async () => {
		const s = await setup();
		const seat = await s.open("p1");
		expect(s.bash("p1", "gh auth status --show-token")).toBe("deny");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat?.dispatchId ?? null,
				body: "トークンの状態を見てよいですか",
			}),
		);
		await s.intake.handle(say("p1", "許可"));
		expect(s.bash("p1", "gh auth status --show-token")).toBe("allow");
		expect(s.bash("p1", "gh auth status --show-token")).toBe("deny");
	});
});
