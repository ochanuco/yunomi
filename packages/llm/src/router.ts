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
	/** 既定は dev / prod とも Sonnet。Haiku を主モデルにすると宛先でない会話への割り込みが増える（#59）。 */
	primary?: ModelId;
	fallback?: ModelId;
};

export class ModelRouter {
	readonly primary: ModelId;
	readonly #provider: LLMProvider;
	readonly #fallback: ModelId;

	constructor(opts: ModelRouterOptions) {
		this.#provider = opts.provider;
		this.primary = opts.primary ?? SONNET;
		this.#fallback = opts.fallback ?? HAIKU;
	}

	/** `model` を渡すと primary の代わりにそのモデルを使う。 */
	async generate<T>(
		req: Omit<LLMRequest<T>, "model"> & { model?: ModelId },
	): Promise<Result<RoutedResult<T>, DomainError>> {
		const primary = req.model ?? this.primary;
		const first = await this.#provider.generate({ ...req, model: primary });
		if (first.ok) return ok({ ...first.value, fallbackUsed: false });

		const canFallback =
			primary !== this.#fallback &&
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
