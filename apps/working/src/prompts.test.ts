import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, WORKING_INSTRUCTIONS } from "./prompts.ts";

const handoff = join(import.meta.dirname, "..", "handoff");

describe("buildSystemPrompt", () => {
	it("人格、仕事のしかた、引き継ぎの手順、申し送りの雛形の順に並べる", () => {
		const handoffPrompt = readFileSync(join(handoff, "prompt.md"), "utf8");
		const issueTemplate = readFileSync(
			join(handoff, "issue-template.md"),
			"utf8",
		);
		const text = buildSystemPrompt({
			persona: "あなたは人格である。\n",
			handoffPrompt,
			issueTemplate,
		});
		const order = [
			"あなたは人格である。",
			WORKING_INSTRUCTIONS.trim(),
			handoffPrompt.trim(),
			issueTemplate.trim(),
		].map((part) => text.indexOf(part));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
});
