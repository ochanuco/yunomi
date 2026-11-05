import { err, ok, type Result } from "@yunomi/core";
import * as v from "valibot";
import type { LogLevel } from "./logger.ts";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());
const positiveInt = v.pipe(
	v.string(),
	v.regex(/^\d+$/),
	v.transform(Number),
	v.minValue(1),
);

const envSchema = v.object({
	DISCORD_TOKEN: nonEmpty,
	WORKING_TOKEN: nonEmpty,
	WORK_TEXT_CHANNEL_ID: nonEmpty,
	WORK_FORUM_CHANNEL_ID: nonEmpty,
	PORT: v.optional(positiveInt),
	STATE_DIR: v.optional(nonEmpty),
	WORK_DIR: v.optional(nonEmpty),
	PERSONA_SCRIPT: v.optional(nonEmpty),
	CLAUDE_BIN: v.optional(nonEmpty),
	CLAUDE_TIMEOUT_MS: v.optional(positiveInt),
	LOG_LEVEL: v.optional(v.picklist(["debug", "info", "warn", "error"])),
});

export type WorkingConfig = {
	discordToken: string;
	/** gateway と共有するトークン。Authorization: Bearer で受ける。 */
	sharedToken: string;
	workTextChannelId: string;
	workForumChannelId: string;
	port: number;
	/** 投稿とセッションの対応を置くディレクトリ。volume に載せる。 */
	stateDir: string;
	/** Claude CLI の作業ディレクトリ。セッションはこの場所に紐づくので変えない。 */
	workDir: string;
	personaScript: string;
	claudeBin: string;
	claudeTimeoutMs: number;
	logLevel: LogLevel;
};

export const loadConfig = (
	env: Record<string, string | undefined>,
): Result<WorkingConfig, string[]> => {
	// 空文字は未設定として扱う（.env で `KEY=` と書かれがち）
	const cleaned = Object.fromEntries(
		Object.entries(env).filter(([, val]) => val !== undefined && val !== ""),
	);
	const parsed = v.safeParse(envSchema, cleaned);
	if (!parsed.success) {
		return err(
			parsed.issues.map((i) => {
				const path = v.getDotPath(i);
				return path ? `${path}: ${i.message}` : i.message;
			}),
		);
	}
	const e = parsed.output;
	const home = env.HOME ?? "/home/worker";
	return ok({
		discordToken: e.DISCORD_TOKEN,
		sharedToken: e.WORKING_TOKEN,
		workTextChannelId: e.WORK_TEXT_CHANNEL_ID,
		workForumChannelId: e.WORK_FORUM_CHANNEL_ID,
		port: e.PORT ?? 8080,
		stateDir: e.STATE_DIR ?? `${home}/state`,
		workDir: e.WORK_DIR ?? `${home}/work`,
		personaScript: e.PERSONA_SCRIPT ?? `${home}/bin/persona.sh`,
		claudeBin: e.CLAUDE_BIN ?? "claude",
		claudeTimeoutMs: e.CLAUDE_TIMEOUT_MS ?? 30 * 60_000,
		logLevel: e.LOG_LEVEL ?? "info",
	});
};
