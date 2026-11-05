import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-support.ts";
import { classify, decide } from "./decide.ts";
import { GUARD_ENV, guardRunFromEnv } from "./env.ts";
import { createLedger } from "./ledger.ts";

const HOOK = join(import.meta.dirname, "hook.ts");

const runHook = (input: unknown, env: Record<string, string>) => {
	const r = spawnSync(process.execPath, [HOOK], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		env: { PATH: process.env.PATH ?? "", ...env },
		encoding: "utf8",
	});
	return {
		status: r.status,
		out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null,
		stderr: r.stderr,
	};
};

const bash = (command: string) => ({
	tool_name: "Bash",
	tool_input: { command },
	cwd: "/home/worker/work",
});

describe("classify: Bash 以外の道具", () => {
	const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });
	it("作業場所の中の編集と、秘密のない場所の読み取りは通す", () => {
		expect(
			classify({ tool: "Write", target: "/home/worker/work/r/a.ts" }, ctx),
		).toBeNull();
		expect(classify({ tool: "Read", target: "/etc/hosts" }, ctx)).toBeNull();
		expect(
			classify({ tool: "Grep", target: "/home/worker/work foo" }, ctx),
		).toBeNull();
	});
	it("作業場所の外の編集、秘密のある場所の読み取り、知らない道具は止める", () => {
		expect(
			classify({ tool: "Edit", target: "/home/worker/.bashrc" }, ctx),
		).not.toBeNull();
		expect(
			classify(
				{ tool: "Read", target: "/home/worker/.claude/.credentials.json" },
				ctx,
			),
		).not.toBeNull();
		expect(
			classify({ tool: "Grep", target: "/home/worker TOKEN" }, ctx),
		).not.toBeNull();
		expect(classify({ tool: "WebFetch", target: "{}" }, ctx)).not.toBeNull();
	});
});

describe("decide", () => {
	it("許可は同じ操作に 1 回だけ使え、2 回目は止めて記録する", () => {
		const dir = tempDir();
		const ledger = createLedger(dir);
		const base = guardRunFromEnv({ HOME: "/home/worker" });
		const op = { tool: "Bash", target: "git push origin main" };
		const run = { ...base, threadId: "t1", grants: [op], grantId: "g1" };

		expect(decide(bash("git push origin main"), run, ledger).decision).toBe(
			"allow",
		);
		expect(decide(bash("git push origin main"), run, ledger).decision).toBe(
			"deny",
		);
		// 許可していない別の操作は、許可があっても止める
		expect(decide(bash("gh pr merge 1"), run, ledger).decision).toBe("deny");
		expect(ledger.takePending("t1").map((p) => p.operation.target)).toEqual([
			"git push origin main",
			"gh pr merge 1",
		]);
		const events = readFileSync(join(dir, "log.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);
		expect(events).toEqual(["used", "blocked", "blocked"]);
	});
});

describe("guardRunFromEnv: 席の中かどうか", () => {
	const env = {
		HOME: "/home/worker",
		[GUARD_ENV.seatsDir]: "/home/worker/work/orca/workspaces/seats",
	};
	it("席の中なら、その席の worktree を作業場所にし、名前から投稿を引く", () => {
		const run = guardRunFromEnv(
			env,
			"/home/worker/work/orca/workspaces/seats/seat-123/repo",
		);
		expect(run.threadId).toBe("123");
		expect(run.ctx.workDir).toBe(
			"/home/worker/work/orca/workspaces/seats/seat-123",
		);
	});
	it("席の外や、席の名前でない場所は投稿に紐づけない", () => {
		for (const dir of [
			"/home/worker/work",
			"/home/worker/work/orca/workspaces/seats",
			"/home/worker/work/orca/workspaces/seats/other",
			"/home/worker/work/orca/workspaces/seats/seat-../x",
		]) {
			const run = guardRunFromEnv(env, dir);
			expect(run.threadId).toBe("_");
			expect(run.ctx.workDir).toBe("/home/worker/work");
		}
	});
	it("CLAUDE_PROJECT_DIR があれば cwd より優先する", () => {
		const run = guardRunFromEnv(
			{
				...env,
				CLAUDE_PROJECT_DIR: "/home/worker/work/orca/workspaces/seats/seat-9",
			},
			"/tmp",
		);
		expect(run.threadId).toBe("9");
	});
});

describe("hook.ts（Claude CLI から呼ばれる形で動かす）", () => {
	const SEATS = "/home/worker/work/orca/workspaces/seats";
	const envFor = (stateDir: string) => ({
		HOME: "/home/worker",
		[GUARD_ENV.stateDir]: stateDir,
		[GUARD_ENV.seatsDir]: SEATS,
		CLAUDE_PROJECT_DIR: `${SEATS}/seat-t1`,
	});
	const seatBash = (command: string) => ({
		tool_name: "Bash",
		tool_input: { command },
		cwd: `${SEATS}/seat-t1`,
	});

	it("聞かずに通す操作は allow を返す", () => {
		const state = tempDir();
		const r = runHook(seatBash("git push -u origin HEAD:dev/x"), envFor(state));
		expect(r.status).toBe(0);
		expect(r.out).toEqual(
			expect.objectContaining({
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
			}),
		);
	});

	it("止める操作は deny を返し、席の投稿に紐づけて残す", () => {
		const state = tempDir();
		const r = runHook(seatBash("gh pr merge 3"), envFor(state));
		expect(r.status).toBe(0);
		expect(r.out.permissionDecision).toBe("deny");
		expect(r.out.permissionDecisionReason).toContain("orca orchestration ask");
		expect(createLedger(join(state, "guard")).takePending("t1")).toEqual([
			{
				operation: { tool: "Bash", target: "gh pr merge 3" },
				reason: expect.stringContaining("gh pr merge"),
			},
		]);
	});

	it("受付が書いた許可は 1 回だけ通す", () => {
		const state = tempDir();
		createLedger(join(state, "guard")).grant("t1", {
			grant_id: "g1",
			operations: [{ tool: "Bash", target: "gh pr merge 3" }],
		});
		const env = envFor(state);
		expect(runHook(seatBash("gh pr merge 3"), env).out.permissionDecision).toBe(
			"allow",
		);
		expect(runHook(seatBash("gh pr merge 3"), env).out.permissionDecision).toBe(
			"deny",
		);
	});

	it("入力が読めないときは exit 2 で止める", () => {
		const r = runHook("not json", envFor(tempDir()));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("guard failed");
	});
});
