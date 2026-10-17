import {
	type DomainError,
	externalServiceUnavailable,
	type Result,
} from "@yunomi/core";
import type {
	LLMProvider,
	LLMRequest,
	LLMResult,
	StepRequest,
	StepResult,
} from "./types.ts";

type Scripted = Result<LLMResult<unknown>, DomainError>;
type ScriptedStep = Result<StepResult<unknown>, DomainError>;

/**
 * 呼ばれた順に台本を返し、受けたリクエストを requests に残す。
 * step は generate と別の台本（stepScript）と履歴（stepRequests）を持つ。
 */
export class FakeLLMProvider implements LLMProvider {
	readonly requests: LLMRequest<unknown>[] = [];
	readonly stepRequests: StepRequest<unknown>[] = [];
	readonly #script: Scripted[];
	readonly #stepScript: ScriptedStep[];

	constructor(script: Scripted[] = [], stepScript: ScriptedStep[] = []) {
		this.#script = [...script];
		this.#stepScript = [...stepScript];
	}

	enqueue(...items: Scripted[]): void {
		this.#script.push(...items);
	}

	enqueueStep(...items: ScriptedStep[]): void {
		this.#stepScript.push(...items);
	}

	async generate<T>(
		req: LLMRequest<T>,
	): Promise<Result<LLMResult<T>, DomainError>> {
		this.requests.push(req as LLMRequest<unknown>);
		const next = this.#script.shift();
		if (!next) {
			return {
				ok: false,
				error: externalServiceUnavailable({ service: "fake-llm-script-empty" }),
			};
		}
		return next as Result<LLMResult<T>, DomainError>;
	}

	async step<T>(
		req: StepRequest<T>,
	): Promise<Result<StepResult<T>, DomainError>> {
		this.stepRequests.push(req as StepRequest<unknown>);
		const next = this.#stepScript.shift();
		if (!next) {
			return {
				ok: false,
				error: externalServiceUnavailable({ service: "fake-llm-script-empty" }),
			};
		}
		return next as Result<StepResult<T>, DomainError>;
	}
}
