import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import type { InboundMessage } from "@yunomi/protocol";
import { describe, expect, it } from "vitest";
import { gate, llmOk, T0, turn } from "./e2e/harness.ts";
import { inbound, partnerStub } from "./helpers.ts";

// ふたりが同じチャンネルにいるとき、互いの返事を取り合わず、相手に宛てた話を自分のことにしない。
const YUKARI_BOT = env.PARTNER_DISCORD_USER_ID;
const AKARI_BOT = env.AKARIN_DISCORD_USER_ID as string;
const plus = (ms: number) => new Date(T0.getTime() + ms);

let seq = 0;
const channel = () => {
	seq += 1;
	return `two-c${seq}`;
};

/** akarin は名前で Akarin の DO を引く。yukarin は名簿にない名前で、Yukarin として別の storage を持たせる。 */
const setup = async (name: "akarin" | `yukarin-${string}`) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	const clock = { now: T0 };
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake, clock };
};

const human = (over: Partial<InboundMessage>) =>
	inbound({
		author: { id: "u-two", displayName: "chanu", isBot: false },
		...over,
	});

/** もうひとりのパートナーの bot の発言。Gateway は bot の発言も中継する。 */
const fromBot = (
	botId: string,
	displayName: string,
	over: Partial<InboundMessage>,
) => inbound({ author: { id: botId, displayName, isBot: true }, ...over });

const systemOf = (fake: FakeLLMProvider) =>
	fake.requests
		.at(-1)
		?.system.map((b) => b.text)
		.join("\n") ?? "";

const userTurnOf = (fake: FakeLLMProvider) =>
	String(fake.requests.at(-1)?.messages.at(-1)?.content ?? "");

describe("もうひとりのパートナーの発言", () => {
	it("自分の発言にせず名前のある第三者として残し、プロンプトでももうひとりのパートナーとして見せる", async () => {
		const { stub, fake } = await setup("akarin");
		const ch = channel();
		const fromYukari = await stub.handleDiscordMessage(
			fromBot(YUKARI_BOT, "結月ゆかり", {
				channelId: ch,
				content: "明日のお弁当、私が作りますね",
			}),
		);
		expect(fromYukari.audit.reason).toBe("bot");
		expect(fake.requests).toHaveLength(0);

		const rows = await runInDurableObject(stub, (_o, s) =>
			s.storage.sql
				.exec<{ author_name: string; is_partner: number; is_bot: number }>(
					"SELECT author_name, is_partner, is_bot FROM recent_messages WHERE channel_id = ?",
					ch,
				)
				.toArray(),
		);
		expect(rows).toEqual([
			{ author_name: "結月ゆかり", is_partner: 0, is_bot: 1 },
		]);

		fake.enqueue(llmOk(turn({ messages: ["はい"] })));
		const res = await stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [AKARI_BOT],
				content: `<@${AKARI_BOT}> あかりちゃんはどうする？`,
			}),
		);
		expect(res.action).toBe("reply");
		expect(userTurnOf(fake)).toContain(
			"結月ゆかり（もうひとりのパートナー）: 明日のお弁当、私が作りますね",
		);
		const system = systemOf(fake);
		expect(system).toContain("## もうひとりのパートナー");
		expect(system).toContain("横で聞いていた");
	});

	it("相手に宛てたメンションは名前に置き換えて見せる", async () => {
		const { stub, fake } = await setup("akarin");
		const ch = channel();
		await stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [YUKARI_BOT],
				content: `<@${YUKARI_BOT}> 明日歯医者なんだ`,
			}),
		);
		fake.enqueue(llmOk(turn({ messages: ["はい"] })));
		await stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [AKARI_BOT],
				content: `<@${AKARI_BOT}> こんにちは`,
			}),
		);
		expect(userTurnOf(fake)).toContain("chanu: @結月ゆかり 明日歯医者なんだ");
	});

	it("もうひとりのパートナーがいないチャンネルでは、そのブロックを出さない", async () => {
		const { stub, fake } = await setup("yukarin-alone");
		fake.enqueue(llmOk(turn()));
		await stub.handleDiscordMessage(
			human({
				channelId: channel(),
				mentionedUserIds: [YUKARI_BOT],
				content: "ゆかりさん、こんにちは",
			}),
		);
		expect(systemOf(fake)).not.toContain("## もうひとりのパートナー");
	});
});

describe("返事をするのは宛てられた側だけ", () => {
	it("相手へのメンションは、自分の継続枠の中でも LLM を呼ばずに黙る", async () => {
		const { stub, fake, clock } = await setup("akarin");
		const ch = channel();
		fake.enqueue(llmOk(turn({ messages: ["はーい"] })));
		await stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [AKARI_BOT],
				content: "あかりちゃん",
			}),
		);
		clock.now = plus(30_000);
		const res = await stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [YUKARI_BOT],
				content: `<@${YUKARI_BOT}> 明日のお弁当よろしく`,
			}),
		);
		expect(res.audit.reason).toBe("addressed_to_other");
		expect(fake.requests).toHaveLength(1);
	});

	it("相手の発言へのリプライと、相手の呼び名には返さない", async () => {
		const { stub, fake } = await setup("akarin");
		const ch = channel();
		const yukari = fromBot(YUKARI_BOT, "結月ゆかり", {
			channelId: ch,
			content: "お茶にしましょうか",
		});
		await stub.handleDiscordMessage(yukari);
		const reply = await stub.handleDiscordMessage(
			human({ channelId: ch, replyToMessageId: yukari.messageId }),
		);
		const named = await stub.handleDiscordMessage(
			human({ channelId: ch, content: "ゆかりさん、それいいね" }),
		);
		expect(reply.audit.reason).toBe("addressed_to_other");
		expect(named.audit.reason).toBe("addressed_to_other");
		expect(fake.requests).toHaveLength(0);
	});

	it("宛先のない発言は、最後に話したパートナーが受け持ち、もう一方は黙る", async () => {
		const ch = channel();
		const akarin = await setup("akarin");
		const yukarin = await setup("yukarin-floor");
		// Yukarin が返事をした直後に、Akarin が呼ばれて返事をした
		yukarin.fake.enqueue(llmOk(turn({ messages: ["はい"] })));
		await yukarin.stub.handleDiscordMessage(
			human({
				channelId: ch,
				mentionedUserIds: [YUKARI_BOT],
				content: "ゆかりさん",
			}),
		);
		const toAkari = human({
			channelId: ch,
			mentionedUserIds: [AKARI_BOT],
			content: "あかりちゃんもいる？",
		});
		akarin.fake.enqueue(llmOk(turn({ messages: ["いますよ"] })));
		await akarin.stub.handleDiscordMessage(toAkari);
		await yukarin.stub.handleDiscordMessage(toAkari);
		await yukarin.stub.handleDiscordMessage(
			fromBot(AKARI_BOT, "紲星あかり", {
				channelId: ch,
				content: "いますよ",
			}),
		);

		const open = human({ channelId: ch, content: "今日は暑いね" });
		akarin.fake.enqueue(llmOk(turn({ messages: ["ですね"] })));
		const byAkarin = await akarin.stub.handleDiscordMessage(open);
		const byYukarin = await yukarin.stub.handleDiscordMessage(open);
		expect(byAkarin.action).toBe("reply");
		// Yukarin は 3 分の継続枠の中だが、流れは Akarin に移っている
		expect(byYukarin.audit.reason).toBe("other_partner_floor");
		expect(yukarin.fake.requests).toHaveLength(1);
	});

	it("どちらもまだ話していないチャンネルでは、宛先のない発言は既定のパートナー（Yukarin）の判定に回る", async () => {
		const ch = channel();
		const akarin = await setup("akarin");
		const yukarin = await setup("yukarin-fresh");
		const open = human({ channelId: ch, content: "今日は暑いね" });
		yukarin.fake.enqueue(gate(false));
		const byAkarin = await akarin.stub.handleDiscordMessage(open);
		const byYukarin = await yukarin.stub.handleDiscordMessage(open);
		expect(byAkarin.audit.reason).toBe("other_partner_floor");
		expect(akarin.fake.requests).toHaveLength(0);
		expect(byYukarin.audit.reason).toBe("gate_rejected");
	});

	it("ふたりともメンションされたら、ふたりとも返す", async () => {
		const ch = channel();
		const akarin = await setup("akarin");
		const yukarin = await setup("yukarin-both");
		const both = human({
			channelId: ch,
			mentionedUserIds: [YUKARI_BOT, AKARI_BOT],
			content: "ふたりともおはよう",
		});
		akarin.fake.enqueue(llmOk(turn()));
		yukarin.fake.enqueue(llmOk(turn()));
		expect((await akarin.stub.handleDiscordMessage(both)).action).toBe("reply");
		expect((await yukarin.stub.handleDiscordMessage(both)).action).toBe(
			"reply",
		);
	});
});

describe("相手に宛てた会話から記憶を作らない", () => {
	it("横で聞いた話からは、記憶も Open Loop も作らない", async () => {
		const { stub, fake } = await setup("akarin");
		const ch = channel();
		const author = {
			id: "u-two-memory",
			displayName: "chanu",
			isBot: false,
		};
		await stub.handleDiscordMessage(
			inbound({
				channelId: ch,
				author,
				mentionedUserIds: [YUKARI_BOT],
				content: `<@${YUKARI_BOT}> 金曜に健康診断があるから、終わったら聞いてね`,
			}),
		);
		await stub.flushBackground();
		expect(fake.requests).toHaveLength(0);
		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM facts f JOIN external_identities i ON i.entity_id = f.subject_entity_id
					WHERE f.partner_id = 'akarin' AND i.external_id = ?1) AS facts,
				(SELECT COUNT(*) FROM open_loops WHERE partner_id = 'akarin' AND channel_id = ?2) AS loops`,
		)
			.bind(author.id, ch)
			.first<{ facts: number; loops: number }>();
		expect(counts).toEqual({ facts: 0, loops: 0 });
	});
});
