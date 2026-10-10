import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ignoreOutcome, type Pipeline } from "../src/do/pipeline.ts";
import { inbound, partnerStub } from "./helpers.ts";

const gate = () => {
	let release!: () => void;
	const opened = new Promise<void>((r) => {
		release = r;
	});
	return { opened, release };
};

describe("PartnerDO.handleDiscordMessage", () => {
	it("スタブは常に ignore", async () => {
		const stub = partnerStub("stub-default");
		const res = await stub.handleDiscordMessage(inbound());
		expect(res.action).toBe("ignore");
		expect(res.audit.decision).toBe("ignore");
	});

	it("重複イベントは 1 回だけ処理し、保存済みの結果を返す", async () => {
		const stub = partnerStub("dedupe");
		let calls = 0;
		await runInDurableObject(stub, (o) => {
			o.pipeline = async (m) => {
				calls += 1;
				return ignoreOutcome(m, "not_addressed");
			};
		});
		const msg = inbound({ channelId: "dd" });
		const first = await stub.handleDiscordMessage(msg);
		const second = await stub.handleDiscordMessage({
			...msg,
			eventId: crypto.randomUUID(),
		});
		expect(calls).toBe(1);
		expect(second).toEqual(first);
	});

	it("処理中の再送も同じ結果を共有する", async () => {
		const stub = partnerStub("dedupe-inflight");
		const g = gate();
		let calls = 0;
		await runInDurableObject(stub, (o) => {
			o.pipeline = async (m) => {
				calls += 1;
				await g.opened;
				return ignoreOutcome(m, "not_addressed");
			};
		});
		const msg = inbound({ channelId: "dd2" });
		const a = stub.handleDiscordMessage(msg);
		const b = stub.handleDiscordMessage(msg);
		g.release();
		expect(await a).toEqual(await b);
		expect(calls).toBe(1);
	});

	it("processed_events は 7 日で消える", async () => {
		const stub = partnerStub("ttl");
		const old = inbound({ channelId: "t" });
		await runInDurableObject(stub, (o) => {
			o.now = () => new Date("2026-10-01T00:00:00Z");
		});
		await stub.handleDiscordMessage(old);
		await runInDurableObject(stub, (o) => {
			o.now = () => new Date("2026-10-09T00:00:00Z");
		});
		await stub.handleDiscordMessage(inbound({ channelId: "t" }));
		const rows = await runInDurableObject(stub, (_o, state) =>
			state.storage.sql
				.exec<{ dedupe_key: string }>("SELECT dedupe_key FROM processed_events")
				.toArray()
				.map((r) => r.dedupe_key),
		);
		expect(rows).not.toContain(`discord:${old.messageId}`);
		expect(rows).toHaveLength(1);
	});

	it("同一チャンネルの連投は処理が重ならず、最新の 1 件だけ再判定する", async () => {
		const stub = partnerStub("serialize");
		const g = gate();
		const evaluated: string[] = [];
		let active = 0;
		let maxActive = 0;
		await runInDurableObject(stub, (o) => {
			const pipeline: Pipeline = async (m) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				evaluated.push(m.messageId);
				if (evaluated.length === 1) await g.opened;
				active -= 1;
				return ignoreOutcome(m, "not_addressed");
			};
			o.pipeline = pipeline;
		});
		const m1 = inbound({ channelId: "s" });
		const m2 = inbound({ channelId: "s" });
		const m3 = inbound({ channelId: "s" });
		const m4 = inbound({ channelId: "s" });
		const p1 = stub.handleDiscordMessage(m1);
		// m1 が処理中になってから後続を送る。
		await new Promise((r) => setTimeout(r, 20));
		const p2 = stub.handleDiscordMessage(m2);
		const p3 = stub.handleDiscordMessage(m3);
		const p4 = stub.handleDiscordMessage(m4);
		await new Promise((r) => setTimeout(r, 20));
		g.release();
		const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);

		expect(maxActive).toBe(1);
		expect(evaluated).toEqual([m1.messageId, m4.messageId]);
		expect(r1.audit.reason).toBe("not_addressed");
		expect(r2.audit.reason).toBe("coalesced");
		expect(r3.audit.reason).toBe("coalesced");
		expect(r4.audit.reason).toBe("not_addressed");

		const kept = await runInDurableObject(stub, (_o, state) =>
			state.storage.sql
				.exec<{ message_id: string }>(
					"SELECT message_id FROM recent_messages ORDER BY rowid",
				)
				.toArray()
				.map((r) => r.message_id),
		);
		expect(kept).toEqual([m1, m2, m3, m4].map((m) => m.messageId));
	});

	it("別チャンネルは互いに待たない", async () => {
		const stub = partnerStub("parallel");
		const g = gate();
		await runInDurableObject(stub, (o) => {
			o.pipeline = async (m) => {
				if (m.channelId === "slow") await g.opened;
				return ignoreOutcome(m, "not_addressed");
			};
		});
		const slow = stub.handleDiscordMessage(inbound({ channelId: "slow" }));
		const fast = await stub.handleDiscordMessage(
			inbound({ channelId: "fast" }),
		);
		expect(fast.action).toBe("ignore");
		g.release();
		await slow;
	});

	it("recent は 1 チャンネル 30 件に保たれる", async () => {
		const stub = partnerStub("prune");
		for (let i = 0; i < 35; i++) {
			await stub.handleDiscordMessage(inbound({ channelId: "p" }));
		}
		const n = await runInDurableObject(
			stub,
			(_o, state) =>
				state.storage.sql
					.exec<{ n: number }>("SELECT count(*) AS n FROM recent_messages")
					.one().n,
		);
		expect(n).toBe(30);
	});

	it("DO を作り直しても recent と dedupe が残る", async () => {
		const stub = partnerStub("evict");
		const msg = inbound({ channelId: "e", content: "覚えていて" });
		await stub.handleDiscordMessage(msg);
		await evictDurableObject(stub);

		const fresh = partnerStub("evict");
		const rows = await runInDurableObject(fresh, (_o, state) =>
			state.storage.sql
				.exec<{ content: string }>("SELECT content FROM recent_messages")
				.toArray(),
		);
		expect(rows.map((r) => r.content)).toEqual(["覚えていて"]);

		let calls = 0;
		await runInDurableObject(fresh, (o) => {
			o.pipeline = async (m) => {
				calls += 1;
				return ignoreOutcome(m, "not_addressed");
			};
		});
		await fresh.handleDiscordMessage(msg);
		expect(calls).toBe(0);
	});
});
