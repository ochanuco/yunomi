import {
	type DomainError,
	externalServiceUnavailable,
	type Result,
} from "@yunomi/core";
import type { LLMProvider, LLMRequest, LLMResult } from "./types.ts";

type Scripted = Result<LLMResult<unknown>, DomainError>;

/** 呼ばれた順に台本を返し、受けたリクエストを requests に残す。 */
export class FakeLLMProvider implements LLMProvider {
	readonly requests: LLMRequest<unknown>[] = [];
	readonly #script: Scripted[];

	constructor(script: Scripted[] = []) {
		this.#script = [...script];
	}

	enqueue(...items: Scripted[]): void {
		this.#script.push(...items);
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
}
