import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
} from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";

export type WorkingClientOptions = {
	url: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
};

export type WorkingClient = {
	forward: (
		envelope: DiscordMessageCreatedEnvelope,
	) => Promise<Result<void, DomainError>>;
};

/**
 * 仕事カテゴリの発言を Working 受付へ渡す。
 * 再送しない。受付が落ちている間の発言は捨て、雑談側の処理を待たせない。
 */
export const createWorkingClient = (
	opts: WorkingClientOptions,
): WorkingClient => {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 10_000;
	return {
		forward: async (envelope) => {
			try {
				const res = await doFetch(opts.url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(envelope),
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!res.ok) {
					return err(externalServiceUnavailable({ service: "working" }));
				}
				return ok(undefined);
			} catch {
				return err(externalServiceUnavailable({ service: "working" }));
			}
		},
	};
};
