import { spawn } from "node:child_process";
import { err, ok, type Result } from "@yunomi/core";
import * as v from "valibot";
import { GUARD_ENV } from "./guard/env.ts";
import type { Operation } from "./guard/operation.ts";
import { acceptTitle, SUMMARY_SYSTEM_PROMPT, summaryInput } from "./prompts.ts";

/**
 * Claude CLI に渡す道具と権限。取り消せない操作をどう扱うかはここを差し替えて決める。
 */
export type ClaudePolicy = {
	tools: readonly string[];
	permissionMode: string;
};

/**
 * 読み書きと Bash を渡し、通すかどうかは managed settings の PreToolUse hook（src/guard）が決める。
 * allow のルールを置かないので、hook が落ちたときは dontAsk が断る。
 * 作業場所の .claude/settings.json に権限を足されないよう、managed と --settings 以外の設定は読まない。
 */
export const WORK_POLICY: ClaudePolicy = {
	tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
	permissionMode: "dontAsk",
};

/** hook に渡す、この作業の投稿と持ち主が 1 回だけ許可した操作。 */
export type GuardRunInput = {
	threadId: string;
	grants: readonly Operation[];
	grantId: string | null;
};

/**
 * Claude CLI に渡す環境変数。受付の秘密（Discord のトークン、gateway と共有するトークン）は渡さない。
 * 記憶の口の service token も渡さず、yunomi-memory が STATE_DIR のファイルから読む。
 */
const CLAUDE_ENV_KEYS = [
	"HOME",
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"USER",
	"CLAUDE_CONFIG_DIR",
	"GH_TOKEN",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
] as const;

export const claudeEnv = (
	env: Record<string, string | undefined>,
	guard: { workDir: string; stateDir: string },
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const key of CLAUDE_ENV_KEYS) {
		const val = env[key];
		if (val !== undefined) out[key] = val;
	}
	out[GUARD_ENV.workDir] = guard.workDir;
	out[GUARD_ENV.stateDir] = guard.stateDir;
	return out;
};

export type ClaudeError =
	| { type: "SessionNotFound"; sessionId: string }
	| { type: "ClaudeFailed"; reason: string };

export type SessionRef =
	| { kind: "new"; id: string }
	| { kind: "resume"; id: string }
	/** id のセッションを読んで、新しいセッションとして続ける。元のセッションは変わらない。 */
	| { kind: "fork"; id: string };

export type ClaudeRunner = {
	run: (input: {
		prompt: string;
		session: SessionRef;
		guard: GuardRunInput;
	}) => Promise<Result<{ sessionId: string; text: string }, ClaudeError>>;
	/** フォーラム投稿の件名にする短い要約。セッションを残さない。 */
	summarize: (text: string) => Promise<Result<string, ClaudeError>>;
};

export type ExecResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};
export type Exec = (
	bin: string,
	args: readonly string[],
	opts: {
		stdin: string;
		cwd: string;
		timeoutMs: number;
		env: Record<string, string>;
	},
) => Promise<ExecResult>;

const resultSchema = v.object({
	is_error: v.optional(v.boolean()),
	result: v.optional(v.string()),
	session_id: v.optional(v.string()),
});

export const spawnExec: Exec = (bin, args, opts) =>
	new Promise((resolve) => {
		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: opts.timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (e) =>
			resolve({ code: null, stdout, stderr: String(e) }),
		);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(opts.stdin);
	});

export type ClaudeCliOptions = {
	bin: string;
	cwd: string;
	systemPromptFile: string;
	timeoutMs: number;
	policy: ClaudePolicy;
	/** Claude CLI に渡す環境変数。受付の秘密（Discord のトークンなど）を含めない。 */
	env: Record<string, string>;
	exec?: Exec;
};

export const createClaudeCli = (opts: ClaudeCliOptions): ClaudeRunner => {
	const exec = opts.exec ?? spawnExec;

	const parse = (
		out: ExecResult,
	): Result<{ sessionId: string | null; text: string }, ClaudeError> => {
		const parsed = v.safeParse(
			resultSchema,
			(() => {
				try {
					return JSON.parse(out.stdout);
				} catch {
					return null;
				}
			})(),
		);
		if (out.code !== 0 || !parsed.success || parsed.output.is_error) {
			const detail = parsed.success ? parsed.output.result : undefined;
			return err({
				type: "ClaudeFailed",
				reason: (detail ?? out.stderr).slice(0, 500) || `exit ${out.code}`,
			});
		}
		return ok({
			sessionId: parsed.output.session_id ?? null,
			text: parsed.output.result ?? "",
		});
	};

	return {
		run: async ({ prompt, session, guard }) => {
			const args = [
				"-p",
				"--output-format",
				"json",
				"--system-prompt-file",
				opts.systemPromptFile,
				"--tools",
				opts.policy.tools.join(","),
				"--permission-mode",
				opts.policy.permissionMode,
				"--setting-sources",
				"",
				session.kind === "new" ? "--session-id" : "--resume",
				session.id,
				...(session.kind === "fork" ? ["--fork-session"] : []),
			];
			const out = await exec(opts.bin, args, {
				stdin: prompt,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				env: {
					...opts.env,
					[GUARD_ENV.threadId]: guard.threadId,
					...(guard.grantId === null
						? {}
						: {
								[GUARD_ENV.grantId]: guard.grantId,
								[GUARD_ENV.grants]: JSON.stringify(guard.grants),
							}),
				},
			});
			if (
				session.kind !== "new" &&
				out.code !== 0 &&
				/No conversation found/i.test(`${out.stderr}\n${out.stdout}`)
			) {
				return err({ type: "SessionNotFound", sessionId: session.id });
			}
			const r = parse(out);
			if (!r.ok) return r;
			return ok({
				sessionId: r.value.sessionId ?? session.id,
				text: r.value.text,
			});
		},
		summarize: async (text) => {
			const out = await exec(
				opts.bin,
				[
					"-p",
					"--output-format",
					"json",
					"--model",
					"haiku",
					"--no-session-persistence",
					"--tools",
					"",
					"--system-prompt",
					SUMMARY_SYSTEM_PROMPT,
				],
				{
					stdin: summaryInput(text),
					cwd: opts.cwd,
					timeoutMs: 60_000,
					env: opts.env,
				},
			);
			const r = parse(out);
			if (!r.ok) return r;
			const title = acceptTitle(r.value.text);
			return title === null
				? err({ type: "ClaudeFailed", reason: "summary rejected" })
				: ok(title);
		},
	};
};
