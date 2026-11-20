import type { OrganAvailability, SpeechPort } from "@yunomi/core";
import { createOchoko, type Ochoko } from "./ochoko.ts";

export const SPEECH_ORGAN_ID = "ochoko";

/** 身体が発声のために使う器官の束。 */
export type VoiceOrgans = {
	speech: SpeechPort;
	/** 可用性は ochoko の /healthz がそのまま決める。 */
	checkAvailability(now: Date): Promise<OrganAvailability>;
};

export const composeVoiceOrgans = (parts: { ochoko: Ochoko }): VoiceOrgans => ({
	speech: parts.ochoko,
	async checkAvailability(now) {
		return {
			organId: SPEECH_ORGAN_ID,
			availability: await parts.ochoko.health(),
			checkedAt: now.toISOString(),
		};
	},
});

/** 声が有効で、必要な設定と secret が揃っているときだけ作る。 */
export const defaultVoiceOrgans = (env: Env): VoiceOrgans | null => {
	if (
		env.VOICE_ENABLED !== "1" ||
		!env.OCHOKO_URL ||
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
	});
};
