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

export const MEMORY_KINDS = ["decided", "done"] as const;
/** Worker の WORK_NOTE_SUMMARY_MAX_LENGTH と揃える。 */
export const SUMMARY_MAX_LENGTH = 200;

export type CliOutput = { code: number; stdout: string; stderr: string };

const USAGE = `使い方:
  yunomi-memory read
  yunomi-memory write --kind decided|done --summary "<1行の要約>"
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
	if (command !== "read" && command !== "write") return fail(2, USAGE);
	let values: { kind?: string; summary?: string };
	try {
		values = parseArgs({
			args: [...rest],
			options: { kind: { type: "string" }, summary: { type: "string" } },
			strict: true,
			allowPositionals: false,
		}).values;
	} catch {
		return fail(2, USAGE);
	}
	if (command === "read" && (values.kind || values.summary)) {
		return fail(2, USAGE);
	}
	if (command === "write") {
		if (!MEMORY_KINDS.includes(values.kind as (typeof MEMORY_KINDS)[number])) {
			return fail(2, `--kind は decided か done\n${USAGE}`);
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

	const creds = readCredentials(env);
	if (creds === null) return fail(1, "記憶の口の接続情報がない");
	const base = `${creds.url.replace(/\/$/, "")}/v1/partners/${encodeURIComponent(creds.partner_id)}/working/memory`;
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
						method: "POST",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify({
							discord_user_id: creds.discord_user_id,
							kind: values.kind,
							summary: values.summary,
						}),
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
	return {
		code: 0,
		stdout: `残した: ${values.kind} ${values.summary}\n`,
		stderr: "",
	};
};
