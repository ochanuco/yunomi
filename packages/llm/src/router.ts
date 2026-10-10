import type { DomainError, Result } from "@yunomi/core";
import { err, ok } from "@yunomi/core";
import {
	HAIKU,
	type LLMProvider,
	type LLMRequest,
	type LLMResult,
	type ModelId,
	SONNET,
} from "./types.ts";

export type Env = "development" | "production";

export type RoutedResult<T> = LLMResult<T> & { fallbackUsed: boolean };

export type ModelRouterOptions = {
	provider: LLMProvider;
	env: Env;
	/** 既定は prod=Sonnet / dev=Haiku。 */
	primary?: ModelId;
	fallback?: ModelId;
};

export class ModelRouter {
	readonly primary: ModelId;
	readonly #provider: LLMProvider;
	readonly #fallback: ModelId;

	constructor(opts: ModelRouterOptions) {
		this.#provider = opts.provider;
		this.primary = opts.primary ?? (opts.env === "production" ? SONNET : HAIKU);
		this.#fallback = opts.fallback ?? HAIKU;
	}

	async generate<T>(
		req: Omit<LLMRequest<T>, "model">,
	): Promise<Result<RoutedResult<T>, DomainError>> {
		const first = await this.#provider.generate({
			...req,
			model: this.primary,
		});
		if (first.ok) return ok({ ...first.value, fallbackUsed: false });

		const canFallback =
			this.primary !== this.#fallback &&
			first.error.type === "ExternalServiceUnavailable" &&
			first.error.retryable;
		if (!canFallback) return err(first.error);

		const second = await this.#provider.generate({
			...req,
			model: this.#fallback,
		});
		if (!second.ok) return err(second.error);
		return ok({ ...second.value, fallbackUsed: true });
	}
}
