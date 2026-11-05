import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { systemPrompt, WORKING_INSTRUCTIONS } from "./prompts.ts";

describe("systemPrompt", () => {
	it("人格、仕事のしかた、引き継ぎの指示、申し送りの雛形の順に並べる", async () => {
		const handoffPrompt = await readFile(
			new URL("../handoff/prompt.md", import.meta.url),
			"utf8",
		);
		const handoffTemplate = await readFile(
			new URL("../handoff/issue-template.md", import.meta.url),
			"utf8",
		);
		const prompt = systemPrompt({
			persona: "人格\n",
			handoffPrompt,
			handoffTemplate,
		});
		const at = (part: string) => prompt.indexOf(part);
		expect(at("人格")).toBe(0);
		expect(at(WORKING_INSTRUCTIONS.trim())).toBeGreaterThan(0);
		expect(at("## Mac への引き継ぎ")).toBeGreaterThan(
			at(WORKING_INSTRUCTIONS.trim()),
		);
		// pickup.sh は申し送りの「作業ブランチ」の行を読むので、雛形の行をそのまま渡す
		expect(at("- 作業ブランチ: `{{branch}}`")).toBeGreaterThan(
			at("## Mac への引き継ぎ"),
		);
	});
});
