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
	const tool = (
		threadId: string,
		tool_name: string,
		tool_input: Record<string, unknown>,
	) => {
		const seatDir = join(seatsDir, `seat-${threadId}`);
		const r = spawnSync(process.execPath, [HOOK], {
			input: JSON.stringify({ tool_name, tool_input, cwd: seatDir }),
			env: {
				PATH: process.env.PATH ?? "",
				HOME: join(root, "home"),
				[GUARD_ENV.stateDir]: stateDir,
				[GUARD_ENV.seatsDir]: seatsDir,
				CLAUDE_PROJECT_DIR: seatDir,
			},
			encoding: "utf8",
		});
		return r.status === 0
			? (JSON.parse(r.stdout).hookSpecificOutput.permissionDecision as string)
			: "error";
	};
	const bash = (threadId: string, command: string) =>
		tool(threadId, "Bash", { command });
	const open = async (threadId: string) => {
		d.addThread(threadId, threadId);
		await intake.handle(say(threadId, "頼みます", { first: true }));
		return seats.get(threadId);
	};
	return { d, o, seats, intake, seatsDir, bash, tool, open };
};

describe("席の Claude の取り消せない操作", () => {
	it("聞かずに通す操作は通し、席の外への書き込みは止める", async () => {
		const s = await setup();
		await s.open("p1");
		expect(s.bash("p1", "git push -u origin HEAD:dev/x")).toBe("allow");
		expect(
			s.tool("p1", "Write", {
				file_path: join(s.seatsDir, "seat-p1", "r", "a.ts"),
			}),
		).toBe("allow");
		// ほかの席の作業場所も、この席から見れば外
		expect(
			s.tool("p1", "Write", { file_path: join(s.seatsDir, "seat-p2", "a.ts") }),
		).toBe("deny");
	});

	it("受付とのやりとりの orca だけを通し、席を作る・消す orca は止める", async () => {
		const s = await setup();
		await s.open("p1");
		expect(
			s.bash("p1", 'orca orchestration ask --question "どうしますか"'),
		).toBe("allow");
		expect(
			s.bash(
				"p1",
				'orca orchestration send --type worker_done --body "済み" --outcome succeeded',
			),
		).toBe("allow");
		expect(s.bash("p1", "orca worktree rm --worktree active")).toBe("deny");
		expect(
			s.bash("p1", "orca orchestration send --to dispatch:x --subject a"),
		).toBe("deny");
	});

	it("main への push と gh pr merge を止めて投稿で聞き、OK の後に 1 回だけ通す。許可はほかの投稿の席に効かない", async () => {
		const s = await setup();
		const seat = await s.open("p1");
		await s.open("p2");
		expect(s.bash("p1", "git push origin main")).toBe("deny");
		expect(s.bash("p1", "gh pr merge 3")).toBe("deny");

		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat?.dispatchId ?? null,
				body: "マージと main への push をしてよいですか",
			}),
		);
		const asked = s.d.sentTo("p1").at(-1) ?? "";
		expect(asked).toContain("git push origin main");
		expect(asked).toContain("gh pr merge 3");

		await s.intake.handle(say("p1", "OK"));
		expect(s.bash("p2", "gh pr merge 3")).toBe("deny");
		expect(s.bash("p1", "gh pr merge 3")).toBe("allow");
		expect(s.bash("p1", "gh pr merge 3")).toBe("deny");
		expect(s.bash("p1", "git push origin main")).toBe("allow");
	});
});

describe("Bash 以外の道具の許可", () => {
	it("MCP の送信を止めて投稿で聞き、許可の後に同じ引数なら 1 回だけ通す。キーの順が違っても同じ操作とみなす", async () => {
		const s = await setup();
		const seat = await s.open("p1");
		const input = {
			to: "a@example.com",
			subject: "見積もり",
			body: "送ります",
		};
		expect(s.tool("p1", "mcp__claude_ai_Gmail__send_message", input)).toBe(
			"deny",
		);
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
		await s.intake.handle(say("p1", "許可"));
		const reordered = {
			body: "送ります",
			subject: "見積もり",
			to: "a@example.com",
		};
		expect(s.tool("p1", "mcp__claude_ai_Gmail__send_message", reordered)).toBe(
			"allow",
		);
		expect(s.tool("p1", "mcp__claude_ai_Gmail__send_message", input)).toBe(
			"deny",
		);
	});

	it("ToolSearch と MCP の読み取り・生成は聞かずに通す", async () => {
		const s = await setup();
		await s.open("p1");
		expect(
			s.tool("p1", "ToolSearch", { query: "chimera", max_results: 5 }),
		).toBe("allow");
		expect(
			s.tool("p1", "mcp__claude_ai_chimera__create_request", { recipe: "x" }),
		).toBe("allow");
		expect(
			s.tool("p1", "mcp__claude_ai_Gmail__search_threads", { query: "x" }),
		).toBe("allow");
	});
});
