import type { LLMCallObserver, LLMCallRecord, StepMessage } from "@yunomi/llm";

/** Langfuse へ送るのに要る binding。どれか欠けていれば送らない。 */
export type LangfuseEnv = {
	YUNOMI_ENV?: string;
	LANGFUSE_URL?: string;
	LANGFUSE_PUBLIC_KEY?: string;
	LANGFUSE_SECRET_KEY?: string;
	LANGFUSE_ACCESS_CLIENT_ID?: string;
	LANGFUSE_ACCESS_CLIENT_SECRET?: string;
};

export type LangfuseConfig = {
	/** Langfuse の origin。 */
	url: string;
	publicKey: string;
	secretKey: string;
	accessClientId: string;
	accessClientSecret: string;
	/** Langfuse の environment。trace を dev と prod で分ける。 */
	environment: string;
	/** テストが送信を差し替える。既定は Worker の fetch。 */
	fetch?: typeof fetch;
	timeoutMs?: number;
};

export const LANGFUSE_TIMEOUT_MS = 5000;
// 道具の結果や system prompt が長くても、1 つの属性が Langfuse の上限に触れないよう切り詰める。
export const MAX_STRING_LENGTH = 32_000;

export const langfuseConfig = (env: LangfuseEnv): LangfuseConfig | null => {
	const {
		LANGFUSE_URL: url,
		LANGFUSE_PUBLIC_KEY: publicKey,
		LANGFUSE_SECRET_KEY: secretKey,
		LANGFUSE_ACCESS_CLIENT_ID: accessClientId,
		LANGFUSE_ACCESS_CLIENT_SECRET: accessClientSecret,
	} = env;
	if (
		!url ||
		!publicKey ||
		!secretKey ||
		!accessClientId ||
		!accessClientSecret
	)
		return null;
	return {
		url,
		publicKey,
		secretKey,
		accessClientId,
		accessClientSecret,
		environment: env.YUNOMI_ENV ?? "development",
	};
};

export type TurnTraceMeta = {
	partnerId: string;
	channelId: string;
	eventId: string;
	messageId: string;
	authorId: string;
	/** ターンに入った発言。root の観測の input になる。 */
	input: unknown;
	startedAt: number;
};

type AnyValue =
	| { stringValue: string }
	| { boolValue: boolean }
	| { intValue: string };
type Attribute = { key: string; value: AnyValue };

type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Attribute[];
	status: { code: number; message?: string };
};

const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

const hex = (bytes: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

const nanos = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

const str = (key: string, value: string): Attribute => ({
	key,
	value: { stringValue: value },
});

const truncate = (s: string): string =>
	s.length > MAX_STRING_LENGTH
		? `${s.slice(0, MAX_STRING_LENGTH)}…(${s.length} 文字から切り詰め)`
		: s;

// thinking の署名と画像の base64 は読めず、量だけが大きいので中身を落とす。
const sanitize = (value: unknown): unknown => {
	if (typeof value === "string") return truncate(value);
	if (Array.isArray(value)) return value.map(sanitize);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (k === "signature") continue;
			if (k === "data" && typeof v === "string" && v.length > 256) {
				out[k] = `(base64 ${v.length} 文字を省略)`;
				continue;
			}
			out[k] = sanitize(v);
		}
		return out;
	}
	return value;
};

const json = (value: unknown): string => JSON.stringify(sanitize(value));

const messageView = (m: StepMessage): unknown => {
	if ("continuation" in m) return { role: m.role, content: m.continuation };
	if (m.role === "tool_results") return { role: "tool", results: m.results };
	return m;
};

const generationName = (rec: LLMCallRecord): string =>
	`${rec.request.output.name}${rec.kind === "step" ? ".step" : ""}`;

const generationAttributes = (rec: LLMCallRecord): Attribute[] => {
	const req = rec.request;
	const attrs: Attribute[] = [
		str("langfuse.observation.type", "generation"),
		str(
			"langfuse.observation.model.name",
			rec.result.ok ? rec.result.value.model : rec.model,
		),
		str(
			"langfuse.observation.model.parameters",
			json({
				max_tokens: req.maxTokens,
				...(req.effort ? { effort: req.effort } : {}),
			}),
		),
		str(
			"langfuse.observation.input",
			json({
				system: req.system.map((b) => b.text),
				messages: req.messages.map(messageView),
				...("tools" in req ? { tools: req.tools.map((t) => t.name) } : {}),
			}),
		),
		{
			key: "langfuse.observation.metadata.fallback",
			value: { boolValue: rec.fallback },
		},
	];
	const res = rec.result;
	if (!res.ok) {
		attrs.push(
			str("langfuse.observation.level", "ERROR"),
			str(
				"langfuse.observation.status_message",
				`${res.error.type}: ${res.error.message}`,
			),
		);
		return attrs;
	}
	const v = res.value;
	const output =
		"kind" in v && v.kind === "tool_use"
			? { tool_calls: v.toolCalls }
			: (v as { output: unknown }).output;
	attrs.push(
		str("langfuse.observation.output", json(output)),
		// Anthropic の input_tokens はキャッシュの読み書きを含まないので、そのまま input にする。
		str(
			"langfuse.observation.usage_details",
			JSON.stringify({
				input: v.usage.inputTokens,
				output: v.usage.outputTokens,
				cache_read_input_tokens: v.usage.cacheReadTokens,
				cache_creation_input_tokens: v.usage.cacheWriteTokens,
			}),
		),
	);
	if (v.stopReason) {
		attrs.push(str("langfuse.observation.metadata.stop_reason", v.stopReason));
	}
	return attrs;
};

/**
 * 会話のターン 1 回を Langfuse の trace 1 つにする。LLM の呼び出しは generation の観測として root の下に並べる。
 * observe は ModelRouter.withObserver に渡す。
 */
export class TurnTrace {
	readonly traceId = hex(16);
	readonly #rootSpanId = hex(8);
	readonly #meta: TurnTraceMeta;
	readonly #calls: LLMCallRecord[] = [];
	#output: unknown = null;

	constructor(meta: TurnTraceMeta) {
		this.#meta = meta;
	}

	readonly observe: LLMCallObserver = (rec) => {
		this.#calls.push(rec);
	};

	get callCount(): number {
		return this.#calls.length;
	}

	setOutput(output: unknown): void {
		this.#output = output;
	}

	toOtlp(environment: string, endedAt: number): unknown {
		const m = this.#meta;
		// trace の属性は、どの観測から絞り込んでも効くよう全 span に付ける。
		const common: Attribute[] = [
			str("langfuse.environment", environment),
			str("langfuse.trace.name", `${m.partnerId}.turn`),
			str("langfuse.session.id", `${m.partnerId}:${m.channelId}`),
			str("langfuse.user.id", m.authorId),
			str("langfuse.trace.metadata.partner_id", m.partnerId),
			str("langfuse.trace.metadata.channel_id", m.channelId),
			str("langfuse.trace.metadata.event_id", m.eventId),
			str("langfuse.trace.metadata.message_id", m.messageId),
		];
		const root: OtlpSpan = {
			traceId: this.traceId,
			spanId: this.#rootSpanId,
			name: "turn",
			kind: SPAN_KIND_INTERNAL,
			startTimeUnixNano: nanos(m.startedAt),
			endTimeUnixNano: nanos(Math.max(endedAt, m.startedAt)),
			attributes: [
				...common,
				str("langfuse.observation.type", "span"),
				str("langfuse.observation.input", json(m.input)),
				str("langfuse.observation.output", json(this.#output)),
			],
			status: { code: STATUS_OK },
		};
		const generations = this.#calls.map(
			(rec): OtlpSpan => ({
				traceId: this.traceId,
				spanId: hex(8),
				parentSpanId: this.#rootSpanId,
				name: generationName(rec),
				kind: SPAN_KIND_CLIENT,
				startTimeUnixNano: nanos(rec.startedAt),
				endTimeUnixNano: nanos(Math.max(rec.endedAt, rec.startedAt)),
				attributes: [...common, ...generationAttributes(rec)],
				status: rec.result.ok
					? { code: STATUS_OK }
					: { code: STATUS_ERROR, message: rec.result.error.type },
			}),
		);
		return {
			resourceSpans: [
				{
					resource: { attributes: [str("service.name", "yunomi-worker")] },
					scopeSpans: [
						{ scope: { name: "yunomi" }, spans: [root, ...generations] },
					],
				},
			],
		};
	}
}

/**
 * trace を OTLP/HTTP（JSON）で送る。応答経路の外で呼び、失敗は警告のログだけにして投げない。
 * LLM を呼ばなかったターン（自己発言、bot、まとめて捨てた発言）は送らない。
 */
export const exportTurnTrace = async (
	config: LangfuseConfig,
	trace: TurnTrace,
	endedAt: number,
): Promise<void> => {
	if (trace.callCount === 0) return;
	try {
		const body = JSON.stringify(trace.toOtlp(config.environment, endedAt));
		const res = await (config.fetch ?? fetch)(
			new URL("/api/public/otel/v1/traces", config.url),
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Basic ${btoa(`${config.publicKey}:${config.secretKey}`)}`,
					"x-langfuse-ingestion-version": "4",
					"CF-Access-Client-Id": config.accessClientId,
					"CF-Access-Client-Secret": config.accessClientSecret,
				},
				body,
				// Access の認証に落ちたときの login への redirect を追わない。
				redirect: "manual",
				signal: AbortSignal.timeout(config.timeoutMs ?? LANGFUSE_TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			await res.body?.cancel();
			console.warn("langfuse export rejected", {
				status: res.status,
				traceId: trace.traceId,
			});
			return;
		}
		const parsed = (await res.json().catch(() => null)) as {
			partialSuccess?: {
				rejectedSpans?: number | string;
				errorMessage?: string;
			};
		} | null;
		const rejected = Number(parsed?.partialSuccess?.rejectedSpans ?? 0);
		if (rejected > 0) {
			console.warn("langfuse export partially rejected", {
				rejectedSpans: rejected,
				errorMessage: parsed?.partialSuccess?.errorMessage,
				traceId: trace.traceId,
			});
		}
	} catch (e) {
		console.warn("langfuse export failed", {
			error: e instanceof Error ? e.name : String(e),
			traceId: trace.traceId,
		});
	}
};
