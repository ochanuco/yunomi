import type { FamiliarityTier } from "@yunomi/core";

/** familiarity 以下で最も大きい min の段階。tiers は min の昇順（スキーマが保証する）。 */
export const selectFamiliarityTier = (
	tiers: readonly FamiliarityTier[] | undefined,
	familiarity: number,
): FamiliarityTier | null =>
	[...(tiers ?? [])].reverse().find((t) => t.min <= familiarity) ?? null;
