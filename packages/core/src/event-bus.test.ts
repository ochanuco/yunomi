import { describe, expect, it } from "vitest";
import type { Envelope } from "./envelope.ts";
import { InMemoryEventBus } from "./event-bus.ts";

describe("InMemoryEventBus", () => {
	it("publish した Envelope を順に保持する", async () => {
		const bus = new InMemoryEventBus();
		const base = {
			source: "test",
			partner_id: "p",
			occurred_at: "2026-01-01T00:00:00.000Z",
			received_at: "2026-01-01T00:00:00.000Z",
			schema_version: 1,
			payload: null,
		};
		const a: Envelope = { ...base, event_id: "a", type: "t" };
		const b: Envelope = { ...base, event_id: "b", type: "t" };
		await bus.publish(a);
		await bus.publish(b);
		expect(bus.published).toEqual([a, b]);
	});
});
