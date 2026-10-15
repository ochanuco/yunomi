import type {
	DomainError,
	OrganAvailability,
	Result,
	SpeechPort,
} from "@yunomi/core";
import { createOchoko, type Ochoko } from "./ochoko.ts";
import { createWol, type Wol } from "./wol.ts";

export const SPEECH_ORGAN_ID = "ochoko";

/** 身体が発声のために使う器官の束。 */
export type VoiceOrgans = {
	speech: SpeechPort;
	/** 電源（wol）を先に見て、起きているときだけ ochoko に聞く。 */
	checkAvailability(now: Date): Promise<OrganAvailability>;
	wake(): Promise<Result<void, DomainError>>;
};

export const composeVoiceOrgans = (parts: {
	ochoko: Ochoko;
	wol: Wol;
}): VoiceOrgans => ({
	speech: parts.ochoko,
	async checkAvailability(now) {
		const power = await parts.wol.status();
		const availability =
			power === "ready" ? await parts.ochoko.health() : power;
		return {
			organId: SPEECH_ORGAN_ID,
			availability,
			checkedAt: now.toISOString(),
		};
	},
	wake: () => parts.wol.wake(),
});

/** 声が有効で、必要な設定と secret が揃っているときだけ作る。 */
export const defaultVoiceOrgans = (env: Env): VoiceOrgans | null => {
	if (
		env.VOICE_ENABLED !== "1" ||
		!env.OCHOKO_URL ||
		!env.WOL_URL ||
		!env.CF_ACCESS_CLIENT_ID ||
		!env.CF_ACCESS_CLIENT_SECRET ||
		!env.AIVOICE_TOKEN
	) {
		return null;
	}
	const access = {
		clientId: env.CF_ACCESS_CLIENT_ID,
		clientSecret: env.CF_ACCESS_CLIENT_SECRET,
	};
	return composeVoiceOrgans({
		ochoko: createOchoko({
			baseUrl: env.OCHOKO_URL,
			access,
			token: env.AIVOICE_TOKEN,
		}),
		wol: createWol({ baseUrl: env.WOL_URL, access }),
	});
};
