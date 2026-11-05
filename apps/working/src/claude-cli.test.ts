import { describe, expect, it, vi } from "vitest";
import {
	claudeEnv,
	createClaudeCli,
	type Exec,
	WORK_POLICY,
} from "./claude-cli.ts";

const opts = {
	bin: "claude",
	cwd: "/work",
	systemPromptFile: "/state/system.md",
	timeoutMs: 1000,
	policy: WORK_POLICY,
	env: { HOME: "/home/w", YUNOMI_WORK_DIR: "/work" },
};
const guard = { threadId: "t1", grants: [], grantId: null };

const execReturning = (code: number | null, stdout: string, stderr = "") =>
	vi.fn<Exec>(async () => ({ code, stdout, stderr }));

describe("createClaudeCli", () => {
	it("新しいセッションは ID を指定し、人格と hook に任せる権限で起動する", async () => {
		const exec = execReturning(
			0,
			JSON.stringify({
				is_error: false,
				result: "やりました",
				session_id: "s1",
			}),
		);
		const r = await createClaudeCli({ ...opts, exec }).run({
			prompt: "頼みます",
			session: { kind: "new", id: "s1" },
			guard,
		});
		expect(r).toEqual({
			ok: true,
			value: { sessionId: "s1", text: "やりました" },
		});
		const [bin, args, o] = exec.mock.calls[0] ?? [];
		expect(bin).toBe("claude");
		expect(args).toEqual([
			"-p",
			"--output-format",
			"json",
			"--system-prompt-file",
			"/state/system.md",
			"--tools",
			"Read,Glob,Grep,Edit,Write,Bash",
			"--permission-mode",
			"dontAsk",
			"--setting-sources",
			"",
			"--session-id",
			"s1",
		]);
		expect(o).toEqual({
			stdin: "頼みます",
			cwd: "/work",
			timeoutMs: 1000,
			env: {
				HOME: "/home/w",
				YUNOMI_WORK_DIR: "/work",
				YUNOMI_THREAD_ID: "t1",
			},
		});
	});

	it("許可した操作は、その回の環境変数で hook に渡す", async () => {
		const exec = execReturning(0, JSON.stringify({ result: "ok" }));
		const grants = [{ tool: "Bash", target: "git push origin main" }];
		await createClaudeCli({ ...opts, exec }).run({
			prompt: "OK",
			session: { kind: "resume", id: "s1" },
			guard: { threadId: "t1", grants, grantId: "g1" },
		});
		expect(exec.mock.calls[0]?.[2].env).toEqual(
			expect.objectContaining({
				YUNOMI_THREAD_ID: "t1",
				YUNOMI_GRANT_ID: "g1",
				YUNOMI_GRANTS: JSON.stringify(grants),
			}),
		);
	});

	it("受付の秘密は Claude CLI に渡さない", () => {
		const env = claudeEnv(
			{
				HOME: "/home/w",
				PATH: "/bin",
				GH_TOKEN: "gh",
				DISCORD_TOKEN: "d",
				WORKING_TOKEN: "w",
			},
			{ workDir: "/home/w/work", stateDir: "/home/w/state" },
		);
		expect(env).toEqual({
			HOME: "/home/w",
			PATH: "/bin",
			GH_TOKEN: "gh",
			YUNOMI_WORK_DIR: "/home/w/work",
			YUNOMI_STATE_DIR: "/home/w/state",
		});
	});

	it("続きは --resume で渡し、見つからなければ SessionNotFound を返す", async () => {
		const exec = execReturning(
			1,
			"",
			"No conversation found with session ID: s1",
		);
		const r = await createClaudeCli({ ...opts, exec }).run({
			prompt: "続き",
			session: { kind: "resume", id: "s1" },
			guard,
		});
		expect(r).toEqual({
			ok: false,
			error: { type: "SessionNotFound", sessionId: "s1" },
		});
		expect(exec.mock.calls[0]?.[1]).toContain("--resume");
	});

	it("異常終了とエラー結果は ClaudeFailed にする", async () => {
		const failed = await createClaudeCli({
			...opts,
			exec: execReturning(
				0,
				JSON.stringify({ is_error: true, result: "boom" }),
			),
		}).run({ prompt: "x", session: { kind: "new", id: "s" }, guard });
		expect(failed).toEqual({
			ok: false,
			error: { type: "ClaudeFailed", reason: "boom" },
		});
		const crashed = await createClaudeCli({
			...opts,
			exec: execReturning(null, "", "spawn ENOENT"),
		}).run({ prompt: "x", session: { kind: "new", id: "s" }, guard });
		expect(!crashed.ok && crashed.error.type).toBe("ClaudeFailed");
	});

	it("要約は道具なし・セッションなしで 1 行目だけを使う", async () => {
		const exec = execReturning(
			0,
			JSON.stringify({ result: "請求書の整理\n余計" }),
		);
		const r = await createClaudeCli({ ...opts, exec }).summarize("請求書を…");
		expect(r).toEqual({ ok: true, value: "請求書の整理" });
		expect(exec.mock.calls[0]?.[1]).toEqual(
			expect.arrayContaining(["--no-session-persistence", "--tools", ""]),
		);
	});
});
