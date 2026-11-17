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

/** provider を 1 回呼ぶごとの記録。fallback した呼び出しは 2 件になる。 */
export type LLMCallRecord = {
	kind: "generate" | "step";
	/** この呼び出しに渡したモデル。 */
	model: ModelId;
	request: LLMRequest<unknown> | StepRequest<unknown>;
	/** epoch ミリ秒。 */
	startedAt: number;
	endedAt: number;
	/** 主モデルの失敗を受けて fallback のモデルで呼んだか。 */
	fallback: boolean;
	result: Result<LLMResult<unknown> | StepResult<unknown>, DomainError>;
};

export type LLMCallObserver = (record: LLMCallRecord) => void;

export type ModelRouterOptions = {
	provider: LLMProvider;
	/** 呼び出しの記録を受け取る。observer の例外は呼び出し側に漏らさない。 */
	observer?: LLMCallObserver;
	/** 既定は dev / prod とも Sonnet。Haiku を主モデルにすると宛先でない会話への割り込みが増える（#59）。 */
	primary?: ModelId;
	fallback?: ModelId;
};

export class ModelRouter {
	readonly primary: ModelId;
	readonly #provider: LLMProvider;
	readonly #fallback: ModelId;
	readonly #observer: LLMCallObserver | undefined;

	constructor(opts: ModelRouterOptions) {
		this.#provider = opts.provider;
		this.primary = opts.primary ?? SONNET;
		this.#fallback = opts.fallback ?? HAIKU;
		this.#observer = opts.observer;
	}

	/** 同じ provider とモデルで、呼び出しを observer に知らせる router を返す。 */
	withObserver(observer: LLMCallObserver): ModelRouter {
		return new ModelRouter({
			provider: this.#provider,
			primary: this.primary,
			fallback: this.#fallback,
			observer,
		});
	}

	/** `model` を渡すと primary の代わりにそのモデルを使う。 */
	async generate<T>(
		req: Omit<LLMRequest<T>, "model"> & { model?: ModelId },
	): Promise<Result<RoutedResult<T>, DomainError>> {
		return this.#route(req.model, (model, fallback) =>
			this.#observe("generate", model, fallback, { ...req, model }, (r) =>
				this.#provider.generate(r),
			),
		);
	}

	/**
	 * 道具のやりとりの 1 往復。結果の `model` が実際に使われたモデルなので、
	 * 続きの step にはそのモデルを `model` に渡す。
	 */
	async step<T>(
		req: Omit<StepRequest<T>, "model"> & { model?: ModelId },
	): Promise<Result<RoutedStepResult<T>, DomainError>> {
		return this.#route(req.model, (model, fallback) =>
			this.#observe("step", model, fallback, { ...req, model }, async (r) => {
				if (!this.#provider.step) {
					return err({
						...externalServiceUnavailable({ service: "llm:step-unsupported" }),
						retryable: false,
					});
				}
				return this.#provider.step(r);
			}),
		);
	}

	async #observe<Q extends LLMRequest<unknown> | StepRequest<unknown>, R>(
		kind: LLMCallRecord["kind"],
		model: ModelId,
		fallback: boolean,
		req: Q,
		call: (req: Q) => Promise<Result<R, DomainError>>,
	): Promise<Result<R, DomainError>> {
		const observer = this.#observer;
		if (!observer) return call(req);
		// 道具のループは呼び出しのあとで messages に積み足すので、この時点の並びを残す。
		const request = { ...req, messages: [...req.messages] };
		const startedAt = Date.now();
		const result = await call(req);
		try {
			observer({
				kind,
				model,
				request: request as LLMRequest<unknown> | StepRequest<unknown>,
				startedAt,
				endedAt: Date.now(),
				fallback,
				result: result as LLMCallRecord["result"],
			});
		} catch (e) {
			console.error("llm observer failed", e);
		}
		return result;
	}

	async #route<R>(
		requested: ModelId | undefined,
		call: (
			model: ModelId,
			fallback: boolean,
		) => Promise<Result<R, DomainError>>,
	): Promise<Result<R & { fallbackUsed: boolean }, DomainError>> {
		const primary = requested ?? this.primary;
		const first = await call(primary, false);
		if (first.ok) return ok({ ...first.value, fallbackUsed: false });

		const canFallback =
			primary !== this.#fallback &&
			first.error.type === "ExternalServiceUnavailable" &&
			first.error.retryable;
		if (!canFallback) return err(first.error);

		const second = await call(this.#fallback, true);
		if (!second.ok) return err(second.error);
		return ok({ ...second.value, fallbackUsed: true });
	}
}
