import { parseArgs } from "node:util";

export type Command =
	| { name: "help" }
	| { name: "status" }
	| {
			name: "memory-list";
			candidates: boolean;
			all: boolean;
			limit: number;
	  }
	| { name: "open-loops"; all: boolean; limit: number }
	| { name: "interests" }
	| { name: "opinions" }
	| { name: "kpi"; days: number }
	| { name: "audit-tail"; count: number; follow: boolean }
	| { name: "snapshot-list" }
	| { name: "snapshot-create" }
	| { name: "snapshot-pull"; id: string; output: string }
	| { name: "snapshot-seed"; id: string; from: "prod" | "dev"; to: "dev" };

export type Global = {
	env: "dev" | "prod";
	url: string | null;
	partner: string;
	json: boolean;
};

export type ParseResult =
	| { ok: true; command: Command; global: Global }
	| { ok: false; message: string };

export const DEFAULT_PARTNER = "yukarin";
const MAX_PAGE = 200;
const MAX_KPI_DAYS = 365;

const fail = (message: string): ParseResult => ({ ok: false, message });

const toDays = (raw: string | undefined) => {
	if (raw === undefined) return 30;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > MAX_KPI_DAYS) {
		throw new Error(
			`--days は 1 から ${MAX_KPI_DAYS} の整数で指定する: ${raw}`,
		);
	}
	return n;
};

const toCount = (raw: string | undefined, fallback: number, flag: string) => {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) {
		throw new Error(`${flag} は 1 から ${MAX_PAGE} の整数で指定する: ${raw}`);
	}
	return n;
};

export const parseCli = (argv: string[]): ParseResult => {
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				env: { type: "string" },
				url: { type: "string" },
				partner: { type: "string" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
				candidates: { type: "boolean" },
				all: { type: "boolean" },
				days: { type: "string" },
				limit: { type: "string" },
				n: { type: "string", short: "n" },
				follow: { type: "boolean", short: "f" },
				output: { type: "string", short: "o" },
				from: { type: "string" },
				to: { type: "string" },
			},
		});

		const env = values.env ?? "dev";
		if (env !== "dev" && env !== "prod") {
			return fail(`--env は dev か prod: ${env}`);
		}
		const global: Global = {
			env,
			url: values.url ?? null,
			partner: values.partner ?? DEFAULT_PARTNER,
			json: values.json ?? false,
		};
		const [first, second, ...rest] = positionals;
		if (values.help || first === undefined || first === "help") {
			return { ok: true, command: { name: "help" }, global };
		}

		const only = (flags: (keyof typeof values)[]) => {
			const stray = (Object.keys(values) as (keyof typeof values)[]).find(
				(k) =>
					values[k] !== undefined &&
					!flags.includes(k) &&
					!["env", "url", "partner", "json", "help"].includes(k),
			);
			if (stray) {
				throw new Error(`このコマンドでは --${stray} を使えない`);
			}
		};
		const noExtra = (extra: string[]) => {
			if (extra.length > 0) {
				throw new Error(`余分な引数: ${extra.join(" ")}`);
			}
		};

		if (first === "status") {
			only([]);
			noExtra([second, ...rest].filter((x) => x !== undefined));
			return { ok: true, command: { name: "status" }, global };
		}
		if (first === "memory" && second === "list") {
			only(["candidates", "all", "limit"]);
			noExtra(rest);
			if (values.candidates && values.all) {
				throw new Error("--all は Fact 用なので --candidates と併用できない");
			}
			return {
				ok: true,
				command: {
					name: "memory-list",
					candidates: values.candidates ?? false,
					all: values.all ?? false,
					limit: toCount(values.limit, 20, "--limit"),
				},
				global,
			};
		}
		if (first === "open-loops") {
			only(["all", "limit"]);
			noExtra([second, ...rest].filter((x) => x !== undefined));
			return {
				ok: true,
				command: {
					name: "open-loops",
					all: values.all ?? false,
					limit: toCount(values.limit, 20, "--limit"),
				},
				global,
			};
		}
		if (first === "interests" || first === "opinions") {
			only([]);
			noExtra([second, ...rest].filter((x) => x !== undefined));
			return { ok: true, command: { name: first }, global };
		}
		if (first === "kpi") {
			only(["days"]);
			noExtra([second, ...rest].filter((x) => x !== undefined));
			return {
				ok: true,
				command: { name: "kpi", days: toDays(values.days) },
				global,
			};
		}
		if (first === "audit" && second === "tail") {
			only(["n", "follow"]);
			noExtra(rest);
			return {
				ok: true,
				command: {
					name: "audit-tail",
					count: toCount(values.n, 20, "-n"),
					follow: values.follow ?? false,
				},
				global,
			};
		}
		if (first === "snapshot" && second === "list") {
			only([]);
			noExtra(rest);
			return { ok: true, command: { name: "snapshot-list" }, global };
		}
		if (first === "snapshot" && second === "create") {
			only([]);
			noExtra(rest);
			return { ok: true, command: { name: "snapshot-create" }, global };
		}
		if (first === "snapshot" && second === "pull") {
			only(["output"]);
			const [id, ...extra] = rest;
			noExtra(extra);
			if (!id) throw new Error("snapshot id を指定する");
			if (!values.output) throw new Error("-o <file> を指定する");
			return {
				ok: true,
				command: { name: "snapshot-pull", id, output: values.output },
				global,
			};
		}
		if (first === "snapshot" && second === "seed") {
			only(["from", "to"]);
			const [id, ...extra] = rest;
			noExtra(extra);
			if (!id) throw new Error("snapshot id を指定する");
			if (values.url) {
				throw new Error(
					"seed では --url を使えない（YKM_DEV_URL / YKM_PROD_URL で指定する）",
				);
			}
			const { from, to } = values;
			if (to === "prod") {
				throw new Error("--to prod は指定できない（prod への restore は禁止）");
			}
			if (to !== "dev") throw new Error("--to dev を指定する");
			if (from !== "prod" && from !== "dev") {
				throw new Error("--from は dev か prod を指定する");
			}
			if (from === to) throw new Error("--from と --to が同じ環境");
			return {
				ok: true,
				command: { name: "snapshot-seed", id, from, to },
				global,
			};
		}
		return fail(`不明なコマンド: ${[first, second].filter(Boolean).join(" ")}`);
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e));
	}
};

export const HELP = `ykm: Yunomi の状態を読み取り、Snapshot を扱う CLI

使い方:
  ykm status                              State / Relationship / 件数
  ykm memory list [--candidates] [--all] [--limit N]
                                          Fact（既定）か candidate の一覧。Fact は現行だけで、
                                          --all で置き換え済み・期限切れも含める
  ykm open-loops [--all] [--limit N]      未解決の話題（Open Loop）の一覧。既定は open だけで、
                                          --all で resolved / dropped も含める
  ykm interests                           現在の Interest（score の降順）。行の無い topic は
                                          プロファイルの初期値（source: profile）
  ykm opinions                            現在の Opinion（stance と confidence）
  ykm kpi [--days N]                      生活日ごとの KPI（既定 30 日、当日は含まない）
  ykm audit tail [-n N] [-f]              直近の audit（-f で 5 秒ごとに追う）
  ykm snapshot list                       Partner Snapshot の一覧（暗号化済み）
  ykm snapshot create                     Snapshot を今すぐ作成
  ykm snapshot pull <id> -o <file>        暗号化のまま保存（--env prod など）
  ykm snapshot seed <id> --from prod --to dev
                                          元の env から取得し、YKM_AGE_IDENTITY で手元で復号して
                                          dev に restore する。--to は dev のみ

共通オプション:
  --env dev|prod   接続先環境（既定 dev）
  --url URL        接続先 URL を直接指定
  --partner ID     partner id（既定 ${DEFAULT_PARTNER}）
  --json           整形せず JSON を出力
  -h, --help       このヘルプ

環境変数:
  YKM_DEV_URL / YKM_PROD_URL   既定は https://yunomi-dev.chanu.co / https://yunomi.chanu.co
  YKM_ACCESS_CLIENT_ID / YKM_ACCESS_CLIENT_SECRET   Access service token
  YKM_AGE_IDENTITY   snapshot seed の復号に使う age の秘密鍵（op run で渡す）
  localhost 宛てで token が無いときは x-yunomi-dev-caller: ykm を送る
`;
