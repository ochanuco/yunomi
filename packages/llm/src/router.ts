import type { DomainError, Result } from "@yunomi/core";
import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import {
	HAIKU,
	type LLMProvider,
	type LLMRequest,
	type LLMResult,
	type ModelId,
	SONNET,
	type StepRequest,
	type StepResult,
} from "./types.ts";

export type Env = "development" | "production";

export type RoutedResult<T> = LLMResult<T> & { fallbackUsed: boolean };

export type RoutedStepResult<T> = StepResult<T> & { fallbackUsed: boolean };

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
		return this.#route(req.model, (model) =>
			this.#provider.generate({ ...req, model }),
		);
	}

	/**
	 * 道具のやりとりの 1 往復。結果の `model` が実際に使われたモデルなので、
	 * 続きの step にはそのモデルを `model` に渡す。
	 */
	async step<T>(
		req: Omit<StepRequest<T>, "model"> & { model?: ModelId },
	): Promise<Result<RoutedStepResult<T>, DomainError>> {
		return this.#route(req.model, async (model) => {
			if (!this.#provider.step) {
				return err({
					...externalServiceUnavailable({ service: "llm:step-unsupported" }),
					retryable: false,
				});
			}
			return this.#provider.step({ ...req, model });
		});
	}

	async #route<R>(
		requested: ModelId | undefined,
		call: (model: ModelId) => Promise<Result<R, DomainError>>,
	): Promise<Result<R & { fallbackUsed: boolean }, DomainError>> {
		const primary = requested ?? this.primary;
		const first = await call(primary);
		if (first.ok) return ok({ ...first.value, fallbackUsed: false });

		const canFallback =
			primary !== this.#fallback &&
			first.error.type === "ExternalServiceUnavailable" &&
			first.error.retryable;
		if (!canFallback) return err(first.error);

		const second = await call(this.#fallback);
		if (!second.ok) return err(second.error);
		return ok({ ...second.value, fallbackUsed: true });
	}
}
