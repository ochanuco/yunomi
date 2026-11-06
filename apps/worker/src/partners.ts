import {
	DEFAULT_PARTNER_ID,
	isPartnerId,
	PARTNER_IDS,
	type PartnerId,
	type PartnerProfile,
} from "@yunomi/core";
import { akarinProfile } from "@yunomi/partner-akarin";
import { yukarinProfile } from "@yunomi/partner-yukarin";

const PROFILES: Record<PartnerId, PartnerProfile> = {
	yukarin: yukarinProfile,
	akarin: akarinProfile,
};

/** 名簿の順に並べたパートナーのプロファイル。毎日の Snapshot と KPI 集計はこれを全員分回す。 */
export const partnerProfiles: readonly PartnerProfile[] = PARTNER_IDS.map(
	(id) => PROFILES[id],
);

/** 名簿にない ID は null。宛先を検証する経路はこれで unknown_partner を返す。 */
export const partnerProfile = (id: string): PartnerProfile | null =>
	isPartnerId(id) ? PROFILES[id] : null;

export const defaultPartnerProfile: PartnerProfile =
	PROFILES[DEFAULT_PARTNER_ID];
