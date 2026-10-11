import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import {
	type DomainError,
	externalServiceUnavailable,
	validationFailed,
} from "@yunomi/core";
import {
	FakeLLMProvider,
	HAIKU,
	type LLMResult,
	ModelRouter,
} from "@yunomi/llm";
import type { InboundMessage } from "@yunomi/protocol";
import { envelopeBody, inbound, PARTNER_ID, partnerStub } from "../helpers.ts";

export const BOT = env.PARTNER_DISCORD_USER_ID;
export const T0 = new Date("2026-10-11T03:00:00Z");

export const turn = (over: Partial<TurnResponse> = {}): TurnResponse => ({
	utterance: "こんにちは",
	reply_policy: "reply",
	decision_summary: "挨拶されたので返す",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: [],
	open_loops: [],
	resolved_open_loop_ids: [],
	tool_intents: [],
	needs_review: false,
	...over,
});

export const llmOk = (output: TurnResponse, model = HAIKU) => ({
	ok: true as const,
	value: {
		output,
		model,
		usage: {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		latencyMs: 12,
		stopReason: "end_turn",
	} satisfies LLMResult<unknown>,
});

export const transientFailure = () => ({
	ok: false as const,
	error: externalServiceUnavailable({ service: "anthropic" }) as DomainError,
});

export const permanentFailure = () => ({
	ok: false as const,
	error: validationFailed({ issues: ["bad output"] }) as DomainError,
});

type Scripted = ConstructorParameters<typeof FakeLLMProvider>[0];

/** 本番の経路（HTTP -> Worker -> PartnerDO）に FakeLLM と固定時計だけを差し込む。 */
export const installFakeLlm = async (
	script: Scripted,
	opts: { production?: boolean; now?: Date } = {},
) => {
	const fake = new FakeLLMProvider(script);
	const stub = partnerStub(PARTNER_ID);
	await runInDurableObject(stub, (o) => {
		o.now = () => opts.now ?? T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return fake;
};

/** シナリオごとに別の作者・チャンネルを使い、共有の PartnerDO 上でも互いに干渉させない。 */
let seq = 0;
export const newScenario = () => {
	seq += 1;
	return {
		channelId: `e2e-c${seq}`,
		author: { id: `e2e-u${seq}`, displayName: `user${seq}`, isBot: false },
	};
};

export const send = async (msg: InboundMessage) => {
	const res = await exports.default.fetch(
		new Request("http://localhost/v1/interfaces/discord/events", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yunomi-dev-caller": "gateway",
			},
			body: JSON.stringify(envelopeBody(msg)),
		}),
	);
	expectOk(res);
	await partnerStub(PARTNER_ID).flushBackground();
	return res.json<{
		action: "reply" | "ignore";
		content?: string;
		reply_to_message_id?: string;
		partner_message_id?: string;
	}>();
};

export const SENT_URL = "http://localhost/v1/partners/yukarin/discord/sent";

/** Gateway が reply を送り終えたあとの通知。 */
export const notifySent = (body: unknown, url = SENT_URL) =>
	exports.default.fetch(
		new Request(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yunomi-dev-caller": "gateway",
			},
			body: JSON.stringify(body),
		}),
	);

const expectOk = (res: Response) => {
	if (res.status !== 200) throw new Error(`unexpected status ${res.status}`);
};

export const mention = (
	s: ReturnType<typeof newScenario>,
	over: Partial<InboundMessage> = {},
) =>
	inbound({
		channelId: s.channelId,
		author: s.author,
		mentionedUserIds: [BOT],
		content: "ゆかりん、おはよう",
		...over,
	});

export type AuditRow = {
	event_id: string;
	decision: string;
	reason: string;
	model: string | null;
	fallback_used: number;
	degraded: number;
	error_type: string | null;
	detail_json: string;
};

export const auditFor = async (eventId: string) =>
	(
		await env.DB.prepare("SELECT * FROM audit_events WHERE event_id = ?")
			.bind(eventId)
			.all<AuditRow>()
	).results;
