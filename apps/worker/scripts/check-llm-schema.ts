import type { PendingStore } from "@yunomi/capabilities";
import { turnOutput } from "@yunomi/conversation";
import { ClaudeProvider, HAIKU, type ModelId, SONNET } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import {
	type CapabilityEnv,
	defaultCapabilities,
} from "../src/capabilities.ts";
import { toToolSpecs } from "../src/do/tool-loop.ts";

// 本番と同じ登録の経路を、すべての認証情報が揃った env で通す。道具を足したときに一覧の更新漏れが起きない。
const fullEnv: Required<CapabilityEnv> = {
	GOOGLE_CLIENT_ID: "x",
	GOOGLE_CLIENT_SECRET: "x",
	GOOGLE_REFRESH_TOKEN: "x",
	GOOGLE_CALENDAR_ID: "x",
	GOOGLE_PLACES_API_KEY: "x",
	GITHUB_TOKEN: "x",
	GITHUB_DEFAULT_REPO: "x/y",
	OWNER_DISCORD_USER_ID: "x",
	DISCORD_BOT_TOKEN: "x",
};
// 道具の定義を読むだけで呼び出さないので、保留の保存先は使われない。
const unusedPending = new Proxy({} as PendingStore, {
	get: () => () => {
		throw new Error("check-llm-schema は保留を扱わない");
	},
});
const capabilities = defaultCapabilities(fullEnv, {
	pending: unusedPending,
	policy: yukarinProfile.capability_defaults,
	now: () => new Date(),
});
if (!capabilities) {
	console.error("道具が 1 つも登録されなかった");
	process.exit(1);
}
const definitions = capabilities.gate.definitions;
console.log(`道具: ${definitions.map((d) => d.name).join(", ")}`);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	console.error(
		"ANTHROPIC_API_KEY が未設定。例: ANTHROPIC_API_KEY=... pnpm --filter @yunomi/worker check:llm-schema",
	);
	process.exit(1);
}

// provider は API エラーを分類済みの DomainError に潰すため、400 の本文は fetch で拾う。
let lastErrorBody = "";
const capturingFetch: typeof fetch = async (input, init) => {
	const res = await fetch(input, init);
	if (!res.ok) lastErrorBody = await res.clone().text();
	return res;
};

const provider = new ClaudeProvider({ apiKey, fetch: capturingFetch });
const tools = toToolSpecs(definitions);

const check = async (model: ModelId): Promise<boolean> => {
	lastErrorBody = "";
	const res = await provider.step({
		system: [{ text: "短く返事をする。", cache: false }],
		messages: [{ role: "user", content: "こんにちは" }],
		output: turnOutput,
		model,
		maxTokens: 512,
		tools,
	});
	// 400 は schema の不備。出力が途中で切れた等の ValidationFailed はリクエスト自体は通っている。
	if (!res.ok && lastErrorBody) {
		console.error(`NG ${model}: ${lastErrorBody}`);
		return false;
	}
	console.log(`OK ${model}: ${res.ok ? "応答あり" : res.error.type}`);
	return true;
};

let allOk = true;
for (const model of [SONNET, HAIKU]) {
	if (!(await check(model))) allOk = false;
}
process.exit(allOk ? 0 : 1);
