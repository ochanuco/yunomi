import { DEFAULT_PARTNER_ID, isPartnerId, PARTNER_IDS } from "@yunomi/core";
import type { OtherPartner } from "./do/turn.ts";
import { partnerProfile } from "./partners.ts";

/** パートナーごとの Discord の bot。ゆかりは名簿化より前からの名前のまま読み、本番の var と secret を変えずに済ませる。 */
export type PartnerDiscordEnv = {
	PARTNER_DISCORD_USER_ID: string;
	DISCORD_BOT_TOKEN?: string;
	AKARIN_DISCORD_USER_ID?: string;
	AKARIN_DISCORD_BOT_TOKEN?: string;
};

export type PartnerDiscord = {
	/** bot の Discord user id。未設定なら空文字で、自分へのメンションも自分の発言も見分けられない。 */
	userId: string;
	/** Worker が REST で送るときの token。未設定なら Gateway が送る。 */
	botToken: string | null;
};

/** 名簿にない ID（疎通確認の DO など）は既定のパートナーの bot を使う。 */
export const partnerDiscord = (
	env: PartnerDiscordEnv,
	id: string,
): PartnerDiscord => {
	switch (isPartnerId(id) ? id : DEFAULT_PARTNER_ID) {
		case "yukarin":
			return {
				userId: env.PARTNER_DISCORD_USER_ID,
				botToken: env.DISCORD_BOT_TOKEN || null,
			};
		case "akarin":
			return {
				userId: env.AKARIN_DISCORD_USER_ID ?? "",
				botToken: env.AKARIN_DISCORD_BOT_TOKEN || null,
			};
	}
};

/** 自分以外で、bot の user id が設定されているパートナー。 */
export const otherPartners = (
	env: PartnerDiscordEnv,
	self: string,
): OtherPartner[] => {
	const me = isPartnerId(self) ? self : DEFAULT_PARTNER_ID;
	return PARTNER_IDS.flatMap((id) => {
		if (id === me) return [];
		const { userId } = partnerDiscord(env, id);
		const profile = partnerProfile(id);
		if (!userId || !profile) return [];
		return [
			{
				userId,
				displayName: profile.display_name,
				aliases: profile.aliases,
			},
		];
	});
};
