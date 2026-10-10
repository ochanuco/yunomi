import { toJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";
import type { OutputSpec } from "./types.ts";

type Json = Record<string, unknown>;

// structured outputs が受け付けない制約キーワード。受信後に Valibot が再検証するので落としてよい。
const UNSUPPORTED = new Set([
	"$schema",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"format",
	"pattern",
]);

const isObject = (x: unknown): x is Json =>
	typeof x === "object" && x !== null && !Array.isArray(x);

const normalize = (node: unknown): unknown => {
	if (Array.isArray(node)) return node.map(normalize);
	if (!isObject(node)) return node;
	const out: Json = {};
	for (const [k, val] of Object.entries(node)) {
		if (UNSUPPORTED.has(k)) continue;
		out[k] = normalize(val);
	}
	if (out.type === "object" && isObject(out.properties)) {
		out.required = Object.keys(out.properties);
		out.additionalProperties = false;
	}
	return out;
};

/**
 * structured outputs は全 object に additionalProperties:false と全プロパティの required を要求する。
 * 不在は optional ではなく nullable で表すこと。
 */
export const toStructuredJsonSchema = (schema: v.GenericSchema): Json =>
	normalize(toJsonSchema(schema as never, { errorMode: "ignore" })) as Json;

export const defineOutput = <T>(
	name: string,
	schema: v.GenericSchema<unknown, T>,
): OutputSpec<T> => ({
	name,
	schema,
	jsonSchema: toStructuredJsonSchema(schema),
});
