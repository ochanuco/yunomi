import { describe, expect, it } from "vitest";
import { ChannelGate } from "../src/do/channel-gate.ts";

describe("ChannelGate", () => {
	it("飛ばされた待機の coalesced も、届いた順に最新の実行より先に終える", async () => {
		const gate = new ChannelGate();
		const log: string[] = [];
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		const tick = () => new Promise((r) => setTimeout(r, 5));

		const first = gate.run(
			"c1",
			async () => {
				await held;
				log.push("run:1");
				return 1;
			},
			() => 0,
		);
		const skipped = (n: number) =>
			gate.run(
				"c1",
				async () => n,
				async () => {
					await tick();
					log.push(`skip:${n}`);
					return 0;
				},
			);
		const second = skipped(2);
		const third = skipped(3);
		const last = gate.run(
			"c1",
			async () => {
				log.push("run:4");
				return 4;
			},
			() => 0,
		);
		release();

		expect(await Promise.all([first, second, third, last])).toEqual([
			1, 0, 0, 4,
		]);
		expect(log).toEqual(["run:1", "skip:2", "skip:3", "run:4"]);
	});
});
