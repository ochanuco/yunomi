import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DoStore, type RecentMessage } from "../src/do/store.ts";
import { partnerStub } from "./helpers.ts";

let seq = 0;
const row = (over: Partial<RecentMessage>): RecentMessage => {
	seq += 1;
	return {
		channelId: `store-c${seq}`,
		messageId: `store-m${seq}`,
		authorId: "u1",
		authorName: "alice",
		isBot: false,
		isPartner: false,
		content: "x",
		occurredAt: "2026-10-11T03:00:00.000Z",
		...over,
	};
};

const withStore = (fn: (store: DoStore) => void) =>
	runInDurableObject(partnerStub(), (_o, st) =>
		fn(new DoStore(st.storage.sql)),
	);

describe("DoStore.hasMessagesAfter", () => {
	it("対象のあとが partner 発言だけなら false", () =>
		withStore((store) => {
			const target = row({});
			store.appendRecent(target);
			store.appendRecent(
				row({ channelId: target.channelId, isPartner: true, authorId: "bot" }),
			);
			expect(store.hasMessagesAfter(target.channelId, target.messageId)).toBe(
				false,
			);
		}));

	it("対象のあとに人の発言があれば true", () =>
		withStore((store) => {
			const target = row({});
			store.appendRecent(target);
			store.appendRecent(row({ channelId: target.channelId }));
			expect(store.hasMessagesAfter(target.channelId, target.messageId)).toBe(
				true,
			);
		}));

	it("対象のあとに bot の発言があれば true", () =>
		withStore((store) => {
			const target = row({});
			store.appendRecent(target);
			store.appendRecent(row({ channelId: target.channelId, isBot: true }));
			expect(store.hasMessagesAfter(target.channelId, target.messageId)).toBe(
				true,
			);
		}));

	it("対象より前の発言は数えない", () =>
		withStore((store) => {
			const first = row({});
			store.appendRecent(first);
			const target = row({ channelId: first.channelId });
			store.appendRecent(target);
			expect(store.hasMessagesAfter(target.channelId, target.messageId)).toBe(
				false,
			);
		}));

	it("Discord message id でも引ける", () =>
		withStore((store) => {
			const target = row({ isPartner: true });
			store.appendRecent(target);
			store.bindDiscordMessageId(target.messageId, target.channelId, "d-1");
			store.appendRecent(row({ channelId: target.channelId }));
			expect(store.hasMessagesAfter(target.channelId, "d-1")).toBe(true);
		}));

	it("対象が見つからなければ true（返信形式に倒す）", () =>
		withStore((store) => {
			expect(store.hasMessagesAfter("store-none", "missing")).toBe(true);
		}));
});
