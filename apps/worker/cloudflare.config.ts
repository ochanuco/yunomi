import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// 実 UUID は infra Issue (#7) で D1 を作成してから差し替える。
// cf d1 は全ゼロ UUID を拒否するため version/variant ビットを立てた形式にしている。
// ローカルの Miniflare は UUID の実在を問わないため、この値のまま動く。
const D1_ID_DEV = "00000000-0000-4000-8000-000000000000";
const D1_ID_PROD = "00000000-0000-4000-8000-000000000000";

const ACCESS_AUD_PROD =
	"28c0b88e0f64e6dc812df4854fde0645e4d57a934826ce3849f4bb2e8a7d9019";
const ACCESS_AUD_DEV =
	"e00c18aa3cabf85ef55c47bd76646b4afa7c763d7cde887085e9a66df1243865";
const ACCESS_CALLERS_PROD = {
	"e94ca29e08b39e259ad9ec9805c54f3d.access": "gateway",
	"d0ed22fcaa637deaa1a682d71691615d.access": "ykm",
};
const ACCESS_CALLERS_DEV = {
	"96068ba533c2ad93dabb8eb2ced3d1c1.access": "gateway",
	"c12627e314018b2f83b122b99b4a7ec3.access": "ykm",
};

export default defineConfig(({ mode }) => {
	const production = mode === "production";
	const local = mode === "local";
	return {
		worker: {
			name: local ? "yunomi-local" : production ? "yunomi" : "yunomi-dev",
			entrypoint,
			compatibilityDate: "2026-07-01",
			// cf dev はカスタムドメインがあると request.url を書き換えるため、local は domains を持たない。
			...(local
				? {}
				: {
						domains: [production ? "yunomi.chanu.co" : "yunomi-dev.chanu.co"],
					}),
			workersDev: false,
			previewUrls: false,
			env: {
				YUNOMI_ENV: bindings.text(production ? "production" : "development"),
				// x-yunomi-dev-caller を信用するのは local mode だけ。
				ALLOW_DEV_CALLER: bindings.text(local ? "1" : "0"),
				ACCESS_TEAM_DOMAIN: bindings.text("chanuco.cloudflareaccess.com"),
				ACCESS_AUD: bindings.text(
					production ? ACCESS_AUD_PROD : ACCESS_AUD_DEV,
				),
				// service token の common_name -> 呼び出し元。
				ACCESS_CALLERS: bindings.json(
					production ? ACCESS_CALLERS_PROD : ACCESS_CALLERS_DEV,
				),
				// Yukarin bot の Discord user id。メンション判定と自己発言の除外に使う。
				// bot application を作るまでは何にも一致しない仮値を置く。
				PARTNER_DISCORD_USER_ID: bindings.text("0"),
				// Admin API を許可する owner の email。
				OWNER_EMAILS: bindings.json(["teacatus@gmail.com"]),
				ANTHROPIC_API_KEY: bindings.secret(),
				DB: bindings.d1({
					id: production ? D1_ID_PROD : D1_ID_DEV,
					name: production ? "yunomi" : "yunomi-dev",
				}),
				PARTNER: bindings.durableObject({
					worker: local ? "yunomi-local" : production ? "yunomi" : "yunomi-dev",
					exportName: "PartnerDO",
				}),
			},
			// 04:17 JST。詳細 audit の保持期間切れを削除する。
			triggers: [triggers.scheduled({ schedule: "17 19 * * *" })],
			exports: {
				PartnerDO: exports.durableObject({ storage: "sqlite" }),
			},
		},
	};
});
