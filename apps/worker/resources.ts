// cloudflare.config.ts と scripts/deploy.sh が共有する、mode ごとのリソース定義。
// local の D1 id はダミー。cf d1 は全ゼロ UUID を拒否するため version/variant ビットを立てた形式にしている。
// ローカルの Miniflare は UUID の実在を問わないため、この値のまま動く。
export const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

// Yukarin bot の Discord user id（= Application ID）。local は dev bot をそのまま使う。
const DEV_BOT_USER_ID = "1558605895758389250";

// age の recipient（公開鍵）。Worker は暗号化にしか使わず、復号鍵は持たない。
// deploy.sh が AGE_RECIPIENT_PATTERN に合わない値を拒否する（D1 id のプレースホルダ拒否と同じ位置づけ）。
export const AGE_RECIPIENT_PATTERN = "^age1[02-9ac-hj-np-z]{58}$";

// mode によらない、この環境の外部サービスの場所。
export const instance = {
	accessTeamDomain: "chanuco.cloudflareaccess.com",
	// github_read が repo を省略されたときに読む repo。
	githubDefaultRepo: "ochanuco/yunomi",
	chatsumiUrl: "https://chatsumi.chanu.co",
	ochokoUrl: "https://ochoko.chanu.co",
	wolUrl: "https://wol.chanu.co",
} as const;

// Access の application ごとの AUD と、service token の common_name -> 呼び出し元。local は dev の application を使う。
const ACCESS_DEV = {
	accessAud: "e00c18aa3cabf85ef55c47bd76646b4afa7c763d7cde887085e9a66df1243865",
	accessCallers: {
		"96068ba533c2ad93dabb8eb2ced3d1c1.access": "gateway",
		"c12627e314018b2f83b122b99b4a7ec3.access": "ykm",
	},
} as const;

export const resources = {
	development: {
		worker: "yunomi-dev",
		host: "yunomi-dev.chanu.co",
		...ACCESS_DEV,
		d1Id: "df215ab3-5b7d-48c0-862b-f0057320e491",
		partnerDiscordUserId: DEV_BOT_USER_ID,
		discordSendFromWorker: "1",
		voiceEnabled: "1",
		voiceRealization: "shizuku",
		snapshotBucket: "yunomi-dev-snapshots",
		snapshotAgeRecipient:
			"age13g33j0raad3fhl7xeutrf7pkp2f3decwax2udr950mqq3stxnd2qvj2md7",
	},
	production: {
		worker: "yunomi",
		host: "yunomi.chanu.co",
		accessAud:
			"28c0b88e0f64e6dc812df4854fde0645e4d57a934826ce3849f4bb2e8a7d9019",
		accessCallers: {
			"e94ca29e08b39e259ad9ec9805c54f3d.access": "gateway",
			"d0ed22fcaa637deaa1a682d71691615d.access": "ykm",
		},
		d1Id: "38337fba-69e0-4e55-94a3-c5daf93606d2",
		partnerDiscordUserId: "1558613526585671773",
		discordSendFromWorker: "1",
		voiceEnabled: "1",
		voiceRealization: "yukari",
		snapshotBucket: "yunomi-snapshots",
		snapshotAgeRecipient:
			"age1ss5ud6wync43k5mu2zghpdt4tg5lumljvggs26jlxgzu60y3qshsyf0m0e",
	},
	// cf dev 専用。deploy しない（scripts/deploy.sh は development / production だけ受け付ける）。
	local: {
		worker: "yunomi-local",
		host: null,
		...ACCESS_DEV,
		d1Id: D1_PLACEHOLDER_ID,
		partnerDiscordUserId: DEV_BOT_USER_ID,
		discordSendFromWorker: "0",
		voiceEnabled: "0",
		voiceRealization: "yukari",
		snapshotBucket: "yunomi-local-snapshots",
		// テスト用の鍵ペア（対応する identity は test/snapshot-keys.ts）。
		snapshotAgeRecipient:
			"age1s23p452q2n8p2wv5cuqd8trvld0rw80kzrremgsrxdw7lxnx997qmpusg2",
	},
} as const;

export type Mode = keyof typeof resources;
