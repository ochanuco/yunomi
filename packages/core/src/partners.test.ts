import { describe, expect, it } from "vitest";
import { DEFAULT_PARTNER_ID, isPartnerId, PARTNER_IDS } from "./partners.ts";

describe("partners", () => {
	it("既定のパートナーは yukarin", () => {
		expect(DEFAULT_PARTNER_ID).toBe("yukarin");
		expect(PARTNER_IDS).toContain("akarin");
	});

	it("名簿にない ID を拒否する", () => {
		expect(isPartnerId("akarin")).toBe(true);
		expect(isPartnerId("health")).toBe(false);
		expect(isPartnerId("")).toBe(false);
	});
});
