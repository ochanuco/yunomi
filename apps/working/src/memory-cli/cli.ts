// コンテナでは node で直接動かすため、node の組み込み以外を import しない。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** 受付が起動時に書く、記憶の口の接続情報。Claude CLI の環境変数には載せず、この CLI の中でだけ読む。 */
export type MemoryCredentials = {
	url: string;
	client_id: string;
	client_secret: string;
	/** 記憶の持ち主。WORKING_OWNER_DISCORD_USER_IDS の先頭。 */
	discord_user_id: string;
	partner_id: string;
};

export const CREDENTIALS_FILE = "memory-credentials.json";
export const credentialsPathOf = (stateDir: string) =>
	join(stateDir, CREDENTIALS_FILE);

const PARTNER = /^[a-z]+$/;

export const MEMORY_KINDS = ["decided", "done", "goal"] as const;
export const GOAL_CLOSINGS = ["achieved", "dropped"] as const;
/** Worker の WORK_NOTE_SUMMARY_MAX_LENGTH と揃える。 */
export const SUMMARY_MAX_LENGTH = 200;
/** Worker の WATCH_SEEN_KEY_MAX_LENGTH と揃える。 */
export const SEEN_KEY_MAX_LENGTH = 200;

export type CliOutput = { code: number; stdout: string; stderr: string };

const USAGE = `使い方:
  yunomi-memory read
  yunomi-memory write --kind decided|done|goal --summary "<1行の要約>"
  yunomi-memory close --id <目標の id> --status achieved|dropped
  yunomi-memory watch-checked --id <見張りの id> [--seen "<知らせたものの key>"]...
`;

const fail = (code: number, message: string): CliOutput => ({
	code,
	stdout: "",
	stderr: `${message}\n`,
});

const readCredentials = (
	env: Record<string, string | undefined>,
): MemoryCredentials | null => {
	const stateDir =
		env.YUNOMI_STATE_DIR ?? `${env.HOME ?? "/home/worker"}/state`;
	try {
		const c = JSON.parse(
			readFileSync(credentialsPathOf(stateDir), "utf8"),
		) as Partial<MemoryCredentials>;
		const keys = [
			"url",
			"client_id",
			"client_secret",
			"discord_user_id",
			"partner_id",
		] as const;
		return keys.every((k) => typeof c[k] === "string" && c[k] !== "")
			? (c as MemoryCredentials)
			: null;
	} catch {
		return null;
	}
};

/**
 * Working の記憶の口（Worker の /v1/partners/:id/working/memory）を読み書きする。
 * 接続情報は標準出力にも標準エラーにも出さない。Claude CLI の出力に載ると投稿に書かれるため。
 */
export const runMemoryCli = async (
	argv: readonly string[],
	env: Record<string, string | undefined>,
	doFetch: typeof fetch = fetch,
): Promise<CliOutput> => {
	const [command, ...rest] = argv;
	if (
		command !== "read" &&
		command !== "write" &&
		command !== "close" &&
		command !== "watch-checked"
	) {
		return fail(2, USAGE);
	}
	let values: {
		kind?: string;
		summary?: string;
		id?: string;
		status?: string;
		seen?: string[];
	};
	try {
		values = parseArgs({
			args: [...rest],
			options: {
				kind: { type: "string" },
				summary: { type: "string" },
				id: { type: "string" },
				status: { type: "string" },
				seen: { type: "string", multiple: true },
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch {
		return fail(2, USAGE);
	}
	const given = (Object.keys(values) as (keyof typeof values)[]).filter(
		(k) => values[k] !== undefined,
	);
	const allowed: Record<typeof command, readonly string[]> = {
		read: [],
		write: ["kind", "summary"],
		close: ["id", "status"],
		"watch-checked": ["id", "seen"],
	};
	if (given.some((k) => !allowed[command].includes(k))) return fail(2, USAGE);
	if (command === "write") {
		if (!MEMORY_KINDS.includes(values.kind as (typeof MEMORY_KINDS)[number])) {
			return fail(2, `--kind は decided か done か goal\n${USAGE}`);
		}
		const summary = (values.summary ?? "").trim();
		if (summary === "" || /[\r\n]/.test(summary)) {
			return fail(2, "--summary は改行を含まない 1 行で書く");
		}
		if (summary.length > SUMMARY_MAX_LENGTH) {
			return fail(2, `--summary は ${SUMMARY_MAX_LENGTH} 字以内`);
		}
		values.summary = summary;
	}
	if (command === "close") {
		if ((values.id ?? "").trim() === "") return fail(2, USAGE);
		if (
			!GOAL_CLOSINGS.includes(values.status as (typeof GOAL_CLOSINGS)[number])
		) {
			return fail(2, `--status は achieved か dropped\n${USAGE}`);
		}
		values.id = (values.id ?? "").trim();
	}
	if (command === "watch-checked") {
		if ((values.id ?? "").trim() === "") return fail(2, USAGE);
		const seen = (values.seen ?? []).map((k) => k.trim());
		if (seen.some((k) => k === "" || /[\r\n]/.test(k))) {
			return fail(2, "--seen は改行を含まない 1 行で書く");
		}
		if (seen.some((k) => k.length > SEEN_KEY_MAX_LENGTH)) {
			return fail(2, `--seen は ${SEEN_KEY_MAX_LENGTH} 字以内`);
		}
		values.id = (values.id ?? "").trim();
		values.seen = seen;
	}

	const creds = readCredentials(env);
	if (creds === null) return fail(1, "記憶の口の接続情報がない");
	// Akarin の席（Codex）は YUNOMI_PARTNER=akarin を付けて呼ぶ。無ければ接続情報の既定（Yukarin）
	const partner = PARTNER.test(env.YUNOMI_PARTNER ?? "")
		? (env.YUNOMI_PARTNER as string)
		: creds.partner_id;
	const base = `${creds.url.replace(/\/$/, "")}/v1/partners/${encodeURIComponent(partner)}/working/memory`;
	const headers = {
		"CF-Access-Client-Id": creds.client_id,
		"CF-Access-Client-Secret": creds.client_secret,
	};
	let res: Response;
	try {
		res =
			command === "read"
				? await doFetch(
						`${base}?discord_user_id=${encodeURIComponent(creds.discord_user_id)}`,
						{ headers, signal: AbortSignal.timeout(15_000) },
					)
				: await doFetch(base, {
						method: command === "write" ? "POST" : "PATCH",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify(
							command === "write"
								? {
										discord_user_id: creds.discord_user_id,
										kind: values.kind,
										summary: values.summary,
									}
								: command === "close"
									? {
											discord_user_id: creds.discord_user_id,
											id: values.id,
											status: values.status,
										}
									: {
											discord_user_id: creds.discord_user_id,
											watch_id: values.id,
											seen: values.seen,
										},
						),
						signal: AbortSignal.timeout(15_000),
					});
	} catch {
		return fail(1, "記憶の口に届かない");
	}
	const text = await res.text().catch(() => "");
	if (!res.ok) {
		let code = "";
		try {
			const e = JSON.parse(text) as { error?: unknown };
			if (typeof e.error === "string") code = `: ${e.error}`;
		} catch {}
		return fail(1, `記憶の口が ${res.status} を返した${code}`);
	}
	if (command === "read") return { code: 0, stdout: `${text}\n`, stderr: "" };
	if (command === "watch-checked") {
		return {
			code: 0,
			stdout: `調べ終えた: ${values.id}（知らせたもの ${values.seen?.length ?? 0} 件）\n`,
			stderr: "",
		};
	}
	if (command === "close") {
		return {
			code: 0,
			stdout: `閉じた: ${values.status} ${values.id}\n`,
			stderr: "",
		};
	}
	let id = "";
	try {
		const r = JSON.parse(text) as { id?: unknown };
		if (typeof r.id === "string") id = ` (id: ${r.id})`;
	} catch {}
	return {
		code: 0,
		stdout: `残した: ${values.kind} ${values.summary}${id}\n`,
		stderr: "",
	};
};
