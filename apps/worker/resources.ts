// cloudflare.config.ts と scripts/deploy.sh が共有する、mode ごとのリソース定義。
// 実 UUID は infra Issue (#7) で D1 を作成してから差し替える。
// cf d1 は全ゼロ UUID を拒否するため version/variant ビットを立てた形式にしている。
// ローカルの Miniflare は UUID の実在を問わないため、この値のまま動く。
export const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

export const resources = {
	development: {
		worker: "yunomi-dev",
		host: "yunomi-dev.chanu.co",
		d1Id: D1_PLACEHOLDER_ID,
	},
	production: {
		worker: "yunomi",
		host: "yunomi.chanu.co",
		d1Id: D1_PLACEHOLDER_ID,
	},
} as const;

export type Mode = keyof typeof resources;
