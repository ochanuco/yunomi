import Anthropic from "@anthropic-ai/sdk";
import {
	type DomainError,
	externalServiceUnavailable,
	rateLimited,
} from "@yunomi/core";

const SERVICE = "anthropic";

const retryAfterMs = (headers: Headers | undefined): number | null => {
	const sec = Number(headers?.get("retry-after"));
	return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
};

export const refusalError = (): DomainError => ({
	...externalServiceUnavailable({ service: `${SERVICE}:refusal` }),
	message: "Claude が応答を拒否した (refusal)",
	retryable: false,
});

/** 429 は RateLimited、5xx / 529 / 接続・timeout は retryable、それ以外の API エラーは retry しても直らない。 */
export const mapSdkError = (e: unknown): DomainError => {
	if (e instanceof Anthropic.RateLimitError) {
		return rateLimited({ retryAfterMs: retryAfterMs(e.headers) });
	}
	if (
		e instanceof Anthropic.InternalServerError ||
		e instanceof Anthropic.APIConnectionError
	) {
		return externalServiceUnavailable({ service: SERVICE });
	}
	return {
		...externalServiceUnavailable({ service: SERVICE }),
		retryable: false,
	};
};
