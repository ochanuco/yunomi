import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	gatewayResponseSchema,
	replyMessagesOf,
	speakQueueOf,
	toReplyResponse,
	withSpeakQueue,
} from "./discord.ts";

// Worker と Gateway は別々に反映されるので、複数件の返事より前の形（main の discord.ts の写し）とも読み書きできることを確かめる。
const snowflake = v.pipe(v.string(), v.nonEmpty());
const aivoiceValuesSchema = v.object({
	engine: v.literal("aivoice"),
	preset: v.string(),
	presetOverrides: v.object({
		Styles: v.optional(
			v.array(v.object({ Name: v.string(), Value: v.number() })),
		),
	}),
	masterOverrides: v.object({
		Volume: v.number(),
		Speed: v.number(),
		Pitch: v.number(),
		PitchRange: v.number(),
		MiddlePause: v.number(),
		LongPause: v.number(),
		SentencePause: v.number(),
	}),
});

const legacyVoiceDirectiveSchema = v.object({
	join: v.optional(v.object({ guild_id: snowflake, channel_id: snowflake })),
	leave: v.optional(v.object({ guild_id: snowflake })),
	// Gateway が values で合成して channel_id の VC で再生する。テキストは Worker が送り済み
	speak: v.optional(
		v.object({
			channel_id: snowflake,
			text: v.pipe(v.string(), v.minLength(1)),
			values: aivoiceValuesSchema,
		}),
	),
});

const legacyGatewayResponseSchema = v.variant("action", [
	v.object({
		action: v.literal("reply"),
		content: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
		reply_to_message_id: v.optional(snowflake),
		// DO が recent messages に積んだ自分の発言の id。送信後の sent 通知で Discord id と結び付ける
		partner_message_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
		voice: v.optional(legacyVoiceDirectiveSchema),
	}),
	v.object({ action: v.literal("ignore") }),
	// Worker が Discord への送信まで済ませた。Gateway は VC の操作だけを実行する
	v.object({
		action: v.literal("ack"),
		voice: v.optional(legacyVoiceDirectiveSchema),
	}),
]);

const values = {
	engine: "aivoice" as const,
	preset: "結月 ゆかり",
	presetOverrides: {},
	masterOverrides: {
		Volume: 1,
		Speed: 1,
		Pitch: 1,
		PitchRange: 1,
		MiddlePause: 150,
		LongPause: 370,
		SentencePause: 800,
	},
};
const speak = (text: string) => ({ channel_id: "7", text, values });

const parse = <S extends v.GenericSchema>(schema: S, x: unknown) => {
	const r = v.safeParse(schema, x);
	if (!r.success) throw new Error(JSON.stringify(r.issues));
	return r.output as v.InferOutput<S>;
};

describe("新しい Worker → 古い Gateway", () => {
	const reply = toReplyResponse({
		messages: [
			{ content: "えっ", partner_message_id: "partner:x:0" },
			{ content: "本当に", partner_message_id: "partner:x:1" },
		],
		replyToMessageId: "3",
	});

	it("reply は全件を改行でつないだ content と 1 件目の partner_message_id で読める", () => {
		const old = parse(legacyGatewayResponseSchema, reply);
		expect(old).toEqual({
			action: "reply",
			content: "えっ\n本当に",
			partner_message_id: "partner:x:0",
			reply_to_message_id: "3",
		});
	});

	it("つなぐと 2000 文字を超えるときは、content を 1 件目だけにする", () => {
		const long = toReplyResponse({
			messages: [{ content: "a".repeat(1500) }, { content: "b".repeat(1500) }],
		});
		expect(long?.content).toBe("a".repeat(1500));
		expect(() => parse(legacyGatewayResponseSchema, long)).not.toThrow();
	});

	it("voice は speak_queue を落とし、1 件目の speak だけを読む", () => {
		const voice = withSpeakQueue({ leave: { guild_id: "1" } }, [
			speak("えっ"),
			speak("本当に"),
		]);
		const old = parse(legacyGatewayResponseSchema, { action: "ack", voice });
		expect(old).toEqual({
			action: "ack",
			voice: { leave: { guild_id: "1" }, speak: speak("えっ") },
		});
	});
});

describe("古い Worker → 新しい Gateway", () => {
	it("content だけの reply を 1 通として読む", () => {
		const res = parse(gatewayResponseSchema, {
			action: "reply",
			content: "やあ",
			partner_message_id: "partner:x",
		});
		expect(res.action === "reply" && replyMessagesOf(res)).toEqual([
			{ content: "やあ", partner_message_id: "partner:x" },
		]);
	});

	it("speak だけの voice を 1 件の読み上げとして読む", () => {
		const res = parse(gatewayResponseSchema, {
			action: "ack",
			voice: { speak: speak("やあ") },
		});
		expect(res.action === "ack" && speakQueueOf(res.voice)).toEqual([
			speak("やあ"),
		]);
	});
});

describe("新しい Worker → 新しい Gateway", () => {
	it("messages と speak_queue を全件読み、speak と二重にしない", () => {
		const reply = toReplyResponse({
			messages: [{ content: "えっ" }, { content: "本当に" }],
		});
		const voice = withSpeakQueue({}, [speak("えっ"), speak("本当に")]);
		const res = parse(gatewayResponseSchema, { ...reply, voice });
		if (res.action !== "reply") throw new Error("unreachable");
		expect(replyMessagesOf(res).map((m) => m.content)).toEqual([
			"えっ",
			"本当に",
		]);
		expect(speakQueueOf(res.voice).map((s) => s.text)).toEqual([
			"えっ",
			"本当に",
		]);
	});

	it("読み上げがなければ speak も speak_queue も付けない", () => {
		expect(withSpeakQueue({ leave: { guild_id: "1" } }, [])).toEqual({
			leave: { guild_id: "1" },
		});
	});
});
