import { bindings, defineConfig, exports, triggers } from "cf/config";
import { resources } from "./resources.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

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
	const r =
		resources[local ? "local" : production ? "production" : "development"];
	return {
		worker: {
			name: r.worker,
			entrypoint,
			compatibilityDate: "2026-07-01",
			// cf dev はカスタムドメインがあると request.url を書き換えるため、local は domains を持たない。
			...(r.host ? { domains: [r.host] } : {}),
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
				// メンション判定と自己発言の除外に使う。
				PARTNER_DISCORD_USER_ID: bindings.text(r.partnerDiscordUserId),
				// Admin API を許可する owner の email。
				OWNER_EMAILS: bindings.json(["teacatus@gmail.com"]),
				// github_read が repo を省略されたときに読む repo。
				GITHUB_DEFAULT_REPO: bindings.text("ochanuco/yunomi"),
				// web_fetch の呼び先。サービストークンは prod だけが secret で持つ。
				CHATSUMI_URL: bindings.text("https://chatsumi.chanu.co"),
				// home_state の呼び先と、読ませる entity。token は prod だけが secret で持つ。
				HOME_ASSISTANT_URL: bindings.text("https://chanoma.chanu.co"),
				HOME_ENTITY_IDS: bindings.text(
					[
						"person.chanu",
						"sensor.pixel_8a_battery_level",
						"sensor.pixel_8a_battery_state",
						"sensor.pixel_8a_next_alarm",
						"binary_sensor.pixel_8a_interactive",
						"sensor.pixel_8a_detected_activity",
						"sensor.pixel_8a_sleep_duration",
						"sensor.pixel_8a_do_not_disturb_sensor",
						"sensor.pixel_8a_geocoded_location",
						"weather.home",
					].join(","),
				),
				SNAPSHOT_AGE_RECIPIENT: bindings.text(r.snapshotAgeRecipient),
				ANTHROPIC_API_KEY: bindings.secret(),
				// 返事の送信を Worker が担うか。"1" かつ DISCORD_BOT_TOKEN があるときだけ REST で送り、
				// それ以外は従来どおり Gateway に reply を返す。
				DISCORD_SEND_FROM_WORKER: bindings.text(r.discordSendFromWorker),
				DISCORD_BOT_TOKEN: bindings.secret(),
				// 声の添付。"1" で、OCHOKO_URL・WOL_URL と下の secret が揃っているときだけ声にする。
				VOICE_ENABLED: bindings.text(r.voiceEnabled),
				// 声のプロファイルのうち、この環境が使う A.I.VOICE の実現方法の名前。
				VOICE_REALIZATION: bindings.text(r.voiceRealization),
				OCHOKO_URL: bindings.text("https://ochoko.chanu.co"),
				WOL_URL: bindings.text("https://wol.chanu.co"),
				// ochoko と wol の Cloudflare Access の Service Token と、ochoko の Bearer token。
				CF_ACCESS_CLIENT_ID: bindings.secret(),
				CF_ACCESS_CLIENT_SECRET: bindings.secret(),
				AIVOICE_TOKEN: bindings.secret(),
				// 道具（Google カレンダー、Google Places、GitHub、chatsumi、Home Assistant）。prod だけが宣言する。宣言した secret は deploy が必須として検査するため、
				// 値を置かない dev で宣言すると deploy が通らない。
				...(production
					? {
							GOOGLE_CLIENT_ID: bindings.secret(),
							GOOGLE_CLIENT_SECRET: bindings.secret(),
							GOOGLE_REFRESH_TOKEN: bindings.secret(),
							GOOGLE_CALENDAR_ID: bindings.secret(),
							GOOGLE_PLACES_API_KEY: bindings.secret(),
							GITHUB_TOKEN: bindings.secret(),
							CHATSUMI_ACCESS_CLIENT_ID: bindings.secret(),
							CHATSUMI_ACCESS_CLIENT_SECRET: bindings.secret(),
							HOME_ASSISTANT_TOKEN: bindings.secret(),
							OWNER_DISCORD_USER_ID: bindings.secret(),
						}
					: {}),
				// bucket は事前に作成しておく。名前は mode ごとに resources.ts で決める。
				SNAPSHOTS: bindings.r2({ name: r.snapshotBucket }),
				DB: bindings.d1({
					id: r.d1Id,
					name: r.worker,
				}),
				PARTNER: bindings.durableObject({
					worker: r.worker,
					exportName: "PartnerDO",
				}),
			},
			// 04:17 JST。Snapshot の作成と期限切れ削除、日次 KPI 集計、詳細 audit の保持期間切れ削除。
			triggers: [triggers.scheduled({ schedule: "17 19 * * *" })],
			exports: {
				PartnerDO: exports.durableObject({ storage: "sqlite" }),
			},
		},
	};
});
