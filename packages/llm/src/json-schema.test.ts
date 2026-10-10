import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { toStructuredJsonSchema } from "./json-schema.ts";

describe("toStructuredJsonSchema", () => {
	it("全 object に additionalProperties:false と全 required を付け、制約キーワードを除く", () => {
		const s = toStructuredJsonSchema(
			v.object({
				n: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
				list: v.array(v.object({ k: v.nullable(v.string()) })),
			}),
		);
		expect(s).toEqual({
			type: "object",
			properties: {
				n: { type: "number" },
				list: {
					type: "array",
					items: {
						type: "object",
						properties: {
							k: { anyOf: [{ type: "string" }, { type: "null" }] },
						},
						required: ["k"],
						additionalProperties: false,
					},
				},
			},
			required: ["n", "list"],
			additionalProperties: false,
		});
	});
});
