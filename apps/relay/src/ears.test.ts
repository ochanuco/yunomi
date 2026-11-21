import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { EndBehaviorType } from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import {
	createEars,
	createOpusDecoder,
	listen,
	type Receiver,
	SAMPLE_RATE,
	toWav,
	type Utterance,
	UtteranceAssembler,
} from "./ears.ts";

/** 20ms ぶんの 16kHz mono 16bit PCM */
const FRAME_BYTES = (SAMPLE_RATE / 50) * 2;
const frame = () => Buffer.alloc(FRAME_BYTES);

const fakeReceiver = () => {
	const speaking = new EventEmitter();
	const subscriptions = new Map<string, PassThrough>();
	const subscribe = vi.fn((userId: string, _options: unknown) => {
		const s = new PassThrough({ objectMode: true });
		subscriptions.set(userId, s);
		s.once("close", () => subscriptions.delete(userId));
		return s;
	});
	const receiver: Receiver = { speaking, subscriptions, subscribe };
	return { receiver, speaking, subscriptions, subscribe };
};

const fakeDecoder = () => {
	const deleted = vi.fn();
	return {
		deleted,
		create: () => ({
			decode: (packet: Buffer) => {
				if (packet.toString() === "bad") throw new Error("Invalid packet");
				return frame();
			},
			delete: deleted,
		}),
	};
};

const closed = (s: PassThrough) =>
	new Promise<void>((resolve) => s.once("close", resolve));

describe("toWav", () => {
	it("16bit mono の WAV ヘッダーを付ける", () => {
		const wav = Buffer.from(toWav(Buffer.alloc(10), 16_000));
		expect(wav.length).toBe(54);
		expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
		expect(wav.readUInt32LE(4)).toBe(46);
		expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
		expect(wav.readUInt16LE(22)).toBe(1);
		expect(wav.readUInt32LE(24)).toBe(16_000);
		expect(wav.readUInt32LE(28)).toBe(32_000);
		expect(wav.readUInt16LE(34)).toBe(16);
		expect(wav.readUInt32LE(40)).toBe(10);
	});
});

describe("UtteranceAssembler", () => {
	const make = () => {
		const out: Utterance[] = [];
		const a = new UtteranceAssembler({
			userId: "u",
			emit: (u) => out.push(u),
			now: () => new Date("2026-10-24T00:00:00Z"),
		});
		return { a, out };
	};

	it("話し終わりで 1 つの発話にまとめる", () => {
		const { a, out } = make();
		for (let i = 0; i < 50; i++) a.push(frame());
		a.flush();
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			userId: "u",
			durationMs: 1000,
			startedAt: new Date("2026-10-24T00:00:00Z"),
		});
		expect(out[0]?.wav.length).toBe(44 + 50 * FRAME_BYTES);
	});

	it("短すぎる音は発話にしない", () => {
		const { a, out } = make();
		for (let i = 0; i < 10; i++) a.push(frame());
		a.flush();
		a.flush();
		expect(out).toHaveLength(0);
	});

	it("30 秒を超えたら区切り、続きは次の発話にする", () => {
		const { a, out } = make();
		for (let i = 0; i < 1500 + 50; i++) a.push(frame());
		a.flush();
		expect(out.map((u) => u.durationMs)).toEqual([30_000, 1000]);
	});
});

describe("listen", () => {
	it("持ち主の声だけを、無音で終わる購読で受ける", () => {
		const r = fakeReceiver();
		listen(r.receiver, {
			ownerUserId: "owner",
			onUtterance: () => {},
			createDecoder: fakeDecoder().create,
		});
		r.speaking.emit("start", "someone");
		expect(r.subscribe).not.toHaveBeenCalled();
		r.speaking.emit("start", "owner");
		r.speaking.emit("start", "owner");
		expect(r.subscribe).toHaveBeenCalledTimes(1);
		expect(r.subscribe).toHaveBeenCalledWith("owner", {
			end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
		});
	});

	it("購読が終わると発話を渡し、壊れたパケットは飛ばす", async () => {
		const r = fakeReceiver();
		const d = fakeDecoder();
		const out: Utterance[] = [];
		listen(r.receiver, {
			ownerUserId: "owner",
			onUtterance: (u) => out.push(u),
			createDecoder: d.create,
		});
		r.speaking.emit("start", "owner");
		const s = r.subscriptions.get("owner");
		if (!s) throw new Error("not subscribed");
		for (let i = 0; i < 25; i++) s.write(Buffer.from("ok"));
		s.write(Buffer.from("bad"));
		s.end();
		await closed(s);
		expect(out.map((u) => u.durationMs)).toEqual([500]);
		expect(d.deleted).toHaveBeenCalledTimes(1);
		expect(r.subscriptions.has("owner")).toBe(false);
	});

	it("聞くのをやめたら、途中の発話は渡さない", async () => {
		const r = fakeReceiver();
		const out: Utterance[] = [];
		const stop = listen(r.receiver, {
			ownerUserId: "owner",
			onUtterance: (u) => out.push(u),
			createDecoder: fakeDecoder().create,
		});
		r.speaking.emit("start", "owner");
		const s = r.subscriptions.get("owner");
		if (!s) throw new Error("not subscribed");
		for (let i = 0; i < 25; i++) s.write(Buffer.from("ok"));
		stop();
		await closed(s);
		r.speaking.emit("start", "owner");
		expect(out).toHaveLength(0);
		expect(r.subscribe).toHaveBeenCalledTimes(1);
	});
});

describe("createEars", () => {
	it("発話の時点の VC を付けて渡し、VC にいなければ捨てる", async () => {
		const r = fakeReceiver();
		const got: unknown[] = [];
		const ears = createEars({
			ownerUserId: "owner",
			onUtterance: (u, where) => got.push([u.durationMs, where]),
			createDecoder: fakeDecoder().create,
		});
		let where: { guildId: string; channelId: string } | null = {
			guildId: "g",
			channelId: "vc",
		};
		ears.listen(r.receiver, () => where);
		const speak = async () => {
			r.speaking.emit("start", "owner");
			const s = r.subscriptions.get("owner");
			if (!s) throw new Error("not subscribed");
			for (let i = 0; i < 25; i++) s.write(Buffer.from("ok"));
			s.end();
			await closed(s);
		};
		await speak();
		where = null;
		await speak();
		expect(got).toEqual([[500, { guildId: "g", channelId: "vc" }]]);
	});
});

describe("createOpusDecoder", () => {
	it("Opus を 16kHz mono の PCM にデコードする", async () => {
		const { default: OpusScript } = await import("opusscript");
		const enc = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
		const packet = enc.encode(Buffer.alloc(960 * 2 * 2), 960);
		enc.delete();
		const dec = createOpusDecoder();
		expect(dec.decode(packet).length).toBe(FRAME_BYTES);
		dec.delete();
	});
});
