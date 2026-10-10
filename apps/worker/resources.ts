// cloudflare.config.ts と scripts/deploy.sh が共有する、mode ごとのリソース定義。
// local の D1 id はダミー。cf d1 は全ゼロ UUID を拒否するため version/variant ビットを立てた形式にしている。
// ローカルの Miniflare は UUID の実在を問わないため、この値のまま動く。
export const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

// Yukarin bot の Discord user id（= Application ID）。local は dev bot をそのまま使う。
const DEV_BOT_USER_ID = "1558605895758389250";

export const resources = {
	development: {
		worker: "yunomi-dev",
		host: "yunomi-dev.chanu.co",
		d1Id: "df215ab3-5b7d-48c0-862b-f0057320e491",
		partnerDiscordUserId: DEV_BOT_USER_ID,
	},
	production: {
		worker: "yunomi",
		host: "yunomi.chanu.co",
		d1Id: "38337fba-69e0-4e55-94a3-c5daf93606d2",
		// prod bot を作るまでは何にも一致しない仮値。
		partnerDiscordUserId: "0",
	},
	// cf dev 専用。deploy しない（scripts/deploy.sh は development / production だけ受け付ける）。
	local: {
		worker: "yunomi-local",
		host: null,
		d1Id: D1_PLACEHOLDER_ID,
		partnerDiscordUserId: DEV_BOT_USER_ID,
	},
} as const;

export type Mode = keyof typeof resources;
