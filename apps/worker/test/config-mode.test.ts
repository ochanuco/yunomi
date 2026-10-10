import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("cloudflare.config.ts の mode", () => {
	it("ALLOW_DEV_CALLER は local だけ 1", () => {
		expect(env.ALLOW_DEV_CALLER_BY_MODE).toEqual({
			development: "0",
			production: "0",
			local: "1",
		});
	});
});
