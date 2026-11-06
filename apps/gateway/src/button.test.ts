import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { discordButtonPressedEnvelopeSchema } from "@yunomi/protocol";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { type ButtonLike, createButtonHandler } from "./button.ts";
import { silentLogger } from "./logger.ts";

const button: ButtonLike = {
	guildId: "1",
	channelId: "thread1",
	messageId: "m1",
	customId: "approval:grant",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	user: { id: "owner", bot: false, displayName: "alice" },
	categoryId: "work",
};

const setup = (forwardOk = true) => {
	const forward = vi.fn(async (_e: unknown) =>
		forwardOk
			? ok(undefined)
			: err(externalServiceUnavailable({ service: "working" })),
	);
	const ack = vi.fn(async () => {});
	const handle = createButtonHandler({
		partnerId: "yukarin",
		workCategoryIds: new Set(["work"]),
		working: { forward },
		now: () => new Date("2026-01-01T00:00:01.000Z"),
		logger: silentLogger,
	});
	return { forward, ack, handle };
};

describe("createButtonHandler", () => {
	it("仕事カテゴリのボタンは受け取ったと返してから、押した人と custom_id を Working に渡す", async () => {
		const s = setup();
		await s.handle(button, s.ack);
		expect(s.ack).toHaveBeenCalledTimes(1);
		const [sent] = s.forward.mock.calls[0] ?? [];
		expect(v.is(discordButtonPressedEnvelopeSchema, sent)).toBe(true);
		expect(sent).toMatchObject({
			type: "discord.button.pressed",
			partner_id: "yukarin",
			payload: {
				channel_id: "thread1",
				message_id: "m1",
				custom_id: "approval:grant",
				user: { id: "owner", display_name: "alice", is_bot: false },
			},
		});
	});

	it("仕事カテゴリの外のボタンには応えず、渡さない", async () => {
		const s = setup();
		await s.handle({ ...button, categoryId: "chat" }, s.ack);
		await s.handle({ ...button, categoryId: null }, s.ack);
		expect(s.ack).not.toHaveBeenCalled();
		expect(s.forward).not.toHaveBeenCalled();
	});

	it("Working に渡せなくても投げない", async () => {
		const s = setup(false);
		await expect(s.handle(button, s.ack)).resolves.toBeUndefined();
		expect(s.forward).toHaveBeenCalledTimes(1);
	});
});
