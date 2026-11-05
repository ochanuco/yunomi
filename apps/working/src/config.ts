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
	WORKING_OWNER_DISCORD_USER_IDS: nonEmpty,
	PORT: v.optional(positiveInt),
	STATE_DIR: v.optional(nonEmpty),
	WORK_DIR: v.optional(nonEmpty),
	PERSONA_SCRIPT: v.optional(nonEmpty),
	HANDOFF_DIR: v.optional(nonEmpty),
	CLAUDE_BIN: v.optional(nonEmpty),
	ORCA_BIN: v.optional(nonEmpty),
	SEATS_REPO: v.optional(nonEmpty),
	SEATS_DIR: v.optional(nonEmpty),
	SEAT_LIMIT: v.optional(positiveInt),
	SEAT_SLEEP_AFTER_MINUTES: v.optional(positiveInt),
	LOG_LEVEL: v.optional(v.picklist(["debug", "info", "warn", "error"])),
	YUNOMI_URL: v.optional(v.pipe(v.string(), v.url())),
	CF_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	CF_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	MEMORY_BIN: v.optional(nonEmpty),
	MAC_STATE_TOKEN: v.optional(nonEmpty),
	MAC_STATE_PORT: v.optional(positiveInt),
	STANDUP_ENABLED: v.optional(v.picklist(["true", "false"])),
	STANDUP_TIME: v.optional(
		v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
	),
	STANDUP_GITHUB_OWNER: v.optional(nonEmpty),
});

export type WorkingConfig = {
	discordToken: string;
	/** gateway と共有するトークン。Authorization: Bearer で受ける。 */
	sharedToken: string;
	workTextChannelId: string;
	workForumChannelId: string;
	/** この人たちの発言だけで作業する。ほかの人と bot は無視する。 */
	ownerUserIds: ReadonlySet<string>;
	/** 記憶の持ち主。WORKING_OWNER_DISCORD_USER_IDS の先頭。 */
	ownerDiscordUserId: string;
	port: number;
	/** 投稿とセッションの対応を置くディレクトリ。volume に載せる。 */
	stateDir: string;
	/** 受付が自分で動かす CLI の作業ディレクトリ。 */
	workDir: string;
	personaScript: string;
	/** Mac への引き継ぎの指示（prompt.md と issue-template.md）を置いたディレクトリ。 */
	handoffDir: string;
	claudeBin: string;
	orcaBin: string;
	/** 席の worktree の元にする空の git リポジトリ。 */
	seatsRepo: string;
	/** Orca が席の worktree を作る場所。start.sh が hook に渡す値と揃える。 */
	seatsDir: string;
	/** 同時に Claude を動かしておく席の上限。 */
	seatLimit: number;
	/** 決めてほしいままこれだけたった席は Claude を止める。 */
	seatSleepAfterMs: number;
	logLevel: LogLevel;
	/** Working の記憶の口。3 つそろったときだけ yunomi-memory が使える。 */
	memory: { url: string; clientId: string; clientSecret: string } | null;
	memoryBin: string;
	/** Mac から席の状態を受ける口。トークンがなければ待ち受けない。 */
	macState: { token: string; port: number } | null;
	standup: {
		enabled: boolean;
		at: { hour: number; minute: number };
		githubOwner: string;
	};
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
	const owners = e.WORKING_OWNER_DISCORD_USER_IDS.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	const [owner] = owners;
	if (owner === undefined) {
		return err(["WORKING_OWNER_DISCORD_USER_IDS: ID が 1 つもない"]);
	}
	const [hour = 9, minute = 0] = (e.STANDUP_TIME ?? "09:00")
		.split(":")
		.map(Number);
	return ok({
		discordToken: e.DISCORD_TOKEN,
		sharedToken: e.WORKING_TOKEN,
		workTextChannelId: e.WORK_TEXT_CHANNEL_ID,
		workForumChannelId: e.WORK_FORUM_CHANNEL_ID,
		ownerUserIds: new Set(owners),
		ownerDiscordUserId: owner,
		port: e.PORT ?? 8080,
		stateDir: e.STATE_DIR ?? `${home}/state`,
		workDir: e.WORK_DIR ?? `${home}/work`,
		personaScript: e.PERSONA_SCRIPT ?? `${home}/bin/persona.sh`,
		handoffDir: e.HANDOFF_DIR ?? `${home}/handoff`,
		claudeBin: e.CLAUDE_BIN ?? "claude",
		orcaBin: e.ORCA_BIN ?? "orca-ide",
		seatsRepo: e.SEATS_REPO ?? `${home}/work/seats`,
		// Orca は worktree を ~/orca/workspaces/<リポジトリ名> に作り、~/orca は work の volume への symlink
		seatsDir: e.SEATS_DIR ?? `${home}/work/orca/workspaces/seats`,
		seatLimit: e.SEAT_LIMIT ?? 6,
		seatSleepAfterMs: (e.SEAT_SLEEP_AFTER_MINUTES ?? 120) * 60_000,
		logLevel: e.LOG_LEVEL ?? "info",
		memory:
			e.YUNOMI_URL && e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET
				? {
						url: e.YUNOMI_URL,
						clientId: e.CF_ACCESS_CLIENT_ID,
						clientSecret: e.CF_ACCESS_CLIENT_SECRET,
					}
				: null,
		memoryBin: e.MEMORY_BIN ?? "yunomi-memory",
		macState: e.MAC_STATE_TOKEN
			? { token: e.MAC_STATE_TOKEN, port: e.MAC_STATE_PORT ?? 8090 }
			: null,
		standup: {
			enabled: (e.STANDUP_ENABLED ?? "true") === "true",
			at: { hour, minute },
			githubOwner: e.STANDUP_GITHUB_OWNER ?? "ochanuco",
		},
	});
};
