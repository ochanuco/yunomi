import { bindings, defineConfig, exports, triggers } from "cf/config";
import { instance, resources } from "./resources.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

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
				ACCESS_TEAM_DOMAIN: bindings.text(instance.accessTeamDomain),
				ACCESS_AUD: bindings.text(r.accessAud),
				// service token の common_name -> 呼び出し元。
				ACCESS_CALLERS: bindings.json(r.accessCallers),
				// メンション判定と自己発言の除外に使う。
				PARTNER_DISCORD_USER_ID: bindings.text(r.partnerDiscordUserId),
				// Admin API を許可する owner の email。
				OWNER_EMAILS: bindings.json(["teacatus@gmail.com"]),
				// github_read が repo を省略されたときに読む repo。
				GITHUB_DEFAULT_REPO: bindings.text(instance.githubDefaultRepo),
				// web_fetch の呼び先。サービストークンは prod だけが secret で持つ。
				CHATSUMI_URL: bindings.text(instance.chatsumiUrl),
				// home_state の呼び先と、読ませる entity。token は prod だけが secret で持つ。
				HOME_ASSISTANT_URL: bindings.text("https://chanoma.chanu.co"),
				HOME_ENTITY_IDS: bindings.text(
					[
						"person.chanu",
						"sensor.home_chanu_distance",
						"sensor.home_chanu_direction_of_travel",
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
				OCHOKO_URL: bindings.text(instance.ochokoUrl),
				WOL_URL: bindings.text(instance.wolUrl),
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
