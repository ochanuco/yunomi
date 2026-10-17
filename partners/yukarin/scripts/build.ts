import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PartnerProfile, partnerProfileSchema } from "@yunomi/core";
import * as v from "valibot";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** キー順を固定して JSON 化する。版数が記述順に依存しないようにするため。 */
const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_, x: unknown) =>
		x && typeof x === "object" && !Array.isArray(x)
			? Object.fromEntries(
					Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
				)
			: x,
	);

export const loadProfile = (): PartnerProfile => {
	const read = (p: string) => readFileSync(join(root, p), "utf8");
	const raw = parse(read("profile.yaml")) as Record<string, unknown>;
	return v.parse(partnerProfileSchema, {
		...raw,
		identity: {
			official: read("identity/official.md"),
			fanon: read("identity/fanon.md"),
			yunomi: read("identity/yunomi.md"),
		},
		examples: (parse(read("examples.yaml")) as { examples: unknown }).examples,
	});
};

export const computeProfileVersion = (profile: PartnerProfile): string =>
	createHash("sha256")
		.update(canonicalJson(profile))
		.digest("hex")
		.slice(0, 12);

export const generatedPath = join(root, "src/generated/profile.ts");

export const renderGenerated = (): string => {
	const profile = loadProfile();
	return `// 自動生成: pnpm --filter @yunomi/partner-yukarin gen
import type { PartnerProfile } from "@yunomi/core";

export const yukarinProfile: PartnerProfile = ${JSON.stringify(profile, null, "\t")};

export const profileVersion = ${JSON.stringify(computeProfileVersion(profile))};
`;
};
