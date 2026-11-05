import { spawn } from "node:child_process";
import { err, ok, type Result } from "@yunomi/core";
import * as v from "valibot";

/**
 * Claude CLI に渡す道具と権限。取り消せない操作をどう扱うかはここを差し替えて決める。
 */
export type ClaudePolicy = {
	tools: readonly string[];
	permissionMode: string;
};

/** 読むだけの道具に絞り、許可の要る操作は聞かずに断る（-p では聞き返せないため）。 */
export const READ_ONLY_POLICY: ClaudePolicy = {
	tools: ["Read", "Glob", "Grep"],
	permissionMode: "dontAsk",
};

export type ClaudeError =
	| { type: "SessionNotFound"; sessionId: string }
	| { type: "ClaudeFailed"; reason: string };

export type SessionRef =
	| { kind: "new"; id: string }
	| { kind: "resume"; id: string };

export type ClaudeRunner = {
	run: (input: {
		prompt: string;
		session: SessionRef;
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
	opts: { stdin: string; cwd: string; timeoutMs: number },
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
	exec?: Exec;
};

const SUMMARY_PROMPT =
	"次の依頼を、Discord のフォーラム投稿の件名として 40 字以内の日本語 1 行に要約してください。件名だけを出力してください。\n\n";

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
		run: async ({ prompt, session }) => {
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
				session.kind === "new" ? "--session-id" : "--resume",
				session.id,
			];
			const out = await exec(opts.bin, args, {
				stdin: prompt,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
			});
			if (
				session.kind === "resume" &&
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
				],
				{ stdin: SUMMARY_PROMPT + text, cwd: opts.cwd, timeoutMs: 60_000 },
			);
			const r = parse(out);
			if (!r.ok) return r;
			const line = r.value.text.trim().split("\n")[0]?.trim() ?? "";
			return line === ""
				? err({ type: "ClaudeFailed", reason: "empty summary" })
				: ok(line);
		},
	};
};
