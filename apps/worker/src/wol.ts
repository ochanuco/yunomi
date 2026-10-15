import {
	type Availability,
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	type Result,
} from "@yunomi/core";
import * as v from "valibot";
import { type AccessCredentials, accessHeaders } from "./access.ts";

const TIMEOUT_MS = 3_000;

export type WolDeps = {
	baseUrl: string;
	access: AccessCredentials;
	fetch?: typeof fetch;
};

export type Wol = {
	/** GPU 機の電源の状態。online でも ochoko が使えるとは限らないので、ready は「起きている」の意味。 */
	status(): Promise<Availability>;
	wake(): Promise<Result<void, DomainError>>;
};

const statusSchema = v.object({
	state: v.picklist([
		"online",
		"going_to_sleep",
		"sleeping",
		"offline",
		"waking",
	]),
});

// going_to_sleep と offline も起こせる（wol が wake を保留、または再送する）ので asleep にする。
const availabilityOf = {
	online: "ready",
	waking: "waking",
	going_to_sleep: "asleep",
	sleeping: "asleep",
	offline: "asleep",
} as const satisfies Record<
	v.InferOutput<typeof statusSchema>["state"],
	Availability
>;

export const createWol = (deps: WolDeps): Wol => {
	const doFetch = deps.fetch ?? fetch;
	const base = deps.baseUrl.replace(/\/+$/, "");
	const access = accessHeaders(deps.access);

	return {
		async status() {
			try {
				const res = await doFetch(`${base}/status`, {
					headers: access,
					redirect: "manual",
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!res.ok) return "unreachable";
				const parsed = v.safeParse(statusSchema, await res.json());
				return parsed.success
					? availabilityOf[parsed.output.state]
					: "unreachable";
			} catch {
				return "unreachable";
			}
		},

		async wake() {
			let res: Response;
			try {
				res = await doFetch(`${base}/wake`, {
					method: "POST",
					headers: access,
					redirect: "manual",
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
			} catch {
				return err(externalServiceUnavailable({ service: "wol" }));
			}
			// online なら 200、起こし始めた・保留したときは 202。
			if (res.status === 200 || res.status === 202) return ok(undefined);
			if (
				res.status === 401 ||
				res.status === 403 ||
				(res.status >= 300 && res.status < 400)
			) {
				return err(permissionDenied({ actor: "worker", action: "wol" }));
			}
			return err(externalServiceUnavailable({ service: "wol" }));
		},
	};
};
