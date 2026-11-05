import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PartnerId, PartnerProfile } from "@yunomi/core";
import * as akarin from "@yunomi/partner-akarin";
import * as yukarin from "@yunomi/partner-yukarin";
import { scenariosDir } from "./scenario.ts";

export type EvalPartner = {
	profile: PartnerProfile;
	profileVersion: string;
	scenariosDir: string;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** パートナーごとの人格とシナリオ。シナリオは呼び名や話し方が人格ごとに違うので、パートナーごとに持つ。 */
export const EVAL_PARTNERS: Record<PartnerId, EvalPartner> = {
	yukarin: {
		profile: yukarin.yukarinProfile,
		profileVersion: yukarin.profileVersion,
		scenariosDir,
	},
	akarin: {
		profile: akarin.akarinProfile,
		profileVersion: akarin.profileVersion,
		scenariosDir: join(root, "scenarios-akarin"),
	},
};
