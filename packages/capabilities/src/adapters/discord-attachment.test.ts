import type { DomainError, Result } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { readAttachment } from "../definitions/attachment.ts";
import { parseToolInput } from "../input.ts";
import {
	createDiscordAttachmentAdapter,
	MAX_IMAGE_BYTES,
	MAX_TEXT_BYTES,
	MAX_TEXT_CHARS,
} from "./discord-attachment.ts";

type Call = { url: URL; init: RequestInit };
type Step = Response | Error | "hang";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const setup = (steps: Step[]) => {
	const calls: Call[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: new URL(String(input)), init: init ?? {} });
		const step = steps.shift();
		if (step === undefined) throw new Error("想定外の fetch");
		if (step instanceof Error) throw step;
		if (step === "hang") {
			const signal = init?.signal;
			return new Promise<Response>((_, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason));
			});
		}
		return step;
	}) as typeof fetch;
	const adapter = createDiscordAttachmentAdapter({
		fetch: fetchFn,
		botToken: "bot-token",
		timeoutMs: 50,
	});
	return { adapter, calls };
};

const context = (over: Partial<CallContext> = {}): CallContext => ({
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "111",
	sourceMessageId: "222",
	replyToMessageId: "333",
	now: new Date("2026-10-17T03:00:00Z"),
	...over,
});

const read = (
	adapter: ReturnType<typeof setup>["adapter"],
	input: unknown = { message: "current", index: 1 },
	ctx: CallContext = context(),
) =>
	adapter.execute({
		requestId: "req-1",
		tool: readAttachment.name,
		input,
		context: ctx,
	});

const successOf = (
	r: Result<CapabilityResponse, DomainError>,
): CapabilityResponse => {
	if (!r.ok) throw new Error(`成功のはず: ${r.error.message}`);
	return r.value;
};

const cdn = (name: string) =>
	`https://cdn.discordapp.com/attachments/1/2/${name}?ex=a&sig=b`;

const message = (
	attachments: {
		filename: string;
		content_type?: string | null;
		size: number;
		url?: string;
	}[],
) =>
	json({
		id: "222",
		attachments: attachments.map((a) => ({
			id: "9",
			url: cdn(a.filename),
			...a,
		})),
	});

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const bytes = (data: Uint8Array) => new Response(new Blob([data]));

describe("read_attachment の入力", () => {
	it("message は current か reply、index は 1 以上の整数", () => {
		const ok = (raw: unknown) => parseToolInput(readAttachment, raw).ok;
		expect(ok({ message: "current", index: 1 })).toBe(true);
		expect(ok({ message: "reply", index: 3 })).toBe(true);
		expect(ok({ message: "other", index: 1 })).toBe(false);
		expect(ok({ message: "current", index: 0 })).toBe(false);
		expect(ok({ message: "current", index: 1.5 })).toBe(false);
		expect(ok({ message: "current" })).toBe(false);
	});
});

describe("読める添付", () => {
	it("毎回メッセージを取り直し、得た URL から画像を取って image として返す", async () => {
		const { adapter, calls } = setup([
			message([
				{ filename: "a.txt", content_type: "text/plain", size: 3 },
				{ filename: "cut.png", content_type: "image/png", size: PNG.length },
			]),
			bytes(PNG),
		]);
		const res = successOf(
			await read(adapter, { message: "current", index: 2 }),
		);

		expect(calls[0]?.url.pathname).toBe("/api/v10/channels/111/messages/222");
		expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
			"Bot bot-token",
		);
		expect(calls[1]?.url.href).toBe(cdn("cut.png"));
		expect(new Headers(calls[1]?.init.headers).has("authorization")).toBe(
			false,
		);
		expect(res.images).toEqual([
			{ mediaType: "image/png", data: btoa(String.fromCharCode(...PNG)) },
		]);
		expect(res.data).toEqual({
			outcome: "read",
			kind: "image",
			filename: "cut.png",
			content_type: "image/png",
			size: PNG.length,
		});
		expect(res.summary).toContain("cut.png");
		expect(JSON.stringify(res.data)).not.toContain(
			res.images?.[0]?.data ?? "?",
		);
	});

	it("reply は返信先のメッセージを取り直す", async () => {
		const { adapter, calls } = setup([
			message([{ filename: "n.md", content_type: "text/markdown", size: 5 }]),
			new Response("# hi\n"),
		]);
		const res = successOf(await read(adapter, { message: "reply", index: 1 }));
		expect(calls[0]?.url.pathname).toBe("/api/v10/channels/111/messages/333");
		expect(res.data).toMatchObject({
			outcome: "read",
			kind: "text",
			text: "# hi\n",
			truncated: false,
		});
		expect(res.images).toBeUndefined();
	});

	it("content_type が無い・octet-stream でも拡張子がソースコードなら text で読む", async () => {
		const { adapter } = setup([
			message([
				{
					filename: "main.ts",
					content_type: "application/octet-stream",
					size: 9,
				},
			]),
			new Response("const a=1"),
		]);
		expect(successOf(await read(adapter)).data).toMatchObject({
			kind: "text",
			text: "const a=1",
		});
	});

	it("宣言が png でも中身が jpeg なら、中身の種別で返す", async () => {
		const { adapter } = setup([
			message([{ filename: "x.png", content_type: "image/png", size: 6 }]),
			bytes(JPEG),
		]);
		expect(successOf(await read(adapter)).images?.[0]?.mediaType).toBe(
			"image/jpeg",
		);
	});

	it("テキストは文字数の上限で切り、切ったことを添える", async () => {
		const body = "あ".repeat(MAX_TEXT_CHARS + 10);
		const { adapter } = setup([
			message([
				{
					filename: "long.txt",
					content_type: "text/plain",
					size: new TextEncoder().encode(body).length,
				},
			]),
			new Response(body),
		]);
		// 日本語 20010 字は 60KB 強で、バイト上限の内側
		const data = successOf(await read(adapter)).data as {
			text: string;
			truncated: boolean;
			note: string;
		};
		expect(data.truncated).toBe(true);
		expect(data.text).toHaveLength(MAX_TEXT_CHARS);
		expect(data.note).toContain("続きは読めていない");
	});
});

describe("読めない添付", () => {
	const unreadable = async (
		att: Parameters<typeof message>[0],
		input: unknown = { message: "current", index: 1 },
		ctx?: CallContext,
	) => {
		const { adapter, calls } = setup([message(att)]);
		const res = successOf(await read(adapter, input, ctx));
		return { data: res.data as Record<string, unknown>, calls, res };
	};

	it("PDF は unsupported_type で、ファイルを取りに行かない", async () => {
		const { data, calls, res } = await unreadable([
			{ filename: "a.pdf", content_type: "application/pdf", size: 10 },
		]);
		expect(data).toMatchObject({
			outcome: "unsupported_type",
			filename: "a.pdf",
		});
		expect(calls).toHaveLength(1);
		expect(res.images).toBeUndefined();
	});

	it("content_type と拡張子が食い違えば unsupported_type", async () => {
		expect(
			(
				await unreadable([
					{ filename: "x.exe", content_type: "image/png", size: 10 },
				])
			).data.outcome,
		).toBe("unsupported_type");
		expect(
			(
				await unreadable([
					{ filename: "x.png", content_type: "text/plain", size: 10 },
				])
			).data.outcome,
		).toBe("unsupported_type");
	});

	it("画像は 5MB、テキストは 200KB を超えれば too_large で、ダウンロードしない", async () => {
		const image = await unreadable([
			{
				filename: "big.png",
				content_type: "image/png",
				size: MAX_IMAGE_BYTES + 1,
			},
		]);
		expect(image.data.outcome).toBe("too_large");
		expect(image.calls).toHaveLength(1);
		const text = await unreadable([
			{
				filename: "big.txt",
				content_type: "text/plain",
				size: MAX_TEXT_BYTES + 1,
			},
		]);
		expect(text.data.outcome).toBe("too_large");
	});

	it("申告より実際が大きければ、読み途中で too_large にする", async () => {
		const { adapter } = setup([
			message([{ filename: "lie.txt", content_type: "text/plain", size: 10 }]),
			new Response("a".repeat(MAX_TEXT_BYTES + 1)),
		]);
		expect(successOf(await read(adapter)).data).toMatchObject({
			outcome: "too_large",
		});
	});

	it("画像の拡張子でも中身が画像でなければ unsupported_type", async () => {
		const { adapter } = setup([
			message([{ filename: "x.png", content_type: "image/png", size: 4 }]),
			new Response("text"),
		]);
		expect(successOf(await read(adapter)).data).toMatchObject({
			outcome: "unsupported_type",
		});
	});

	it("UTF-8 でないテキストは unsupported_type", async () => {
		const { adapter } = setup([
			message([{ filename: "x.txt", content_type: "text/plain", size: 2 }]),
			bytes(Uint8Array.from([0xff, 0xfe])),
		]);
		expect(successOf(await read(adapter)).data).toMatchObject({
			outcome: "unsupported_type",
		});
	});

	it("番号が範囲外なら件数を添えて not_found", async () => {
		const { data } = await unreadable(
			[{ filename: "a.txt", content_type: "text/plain", size: 1 }],
			{ message: "current", index: 2 },
		);
		expect(data.outcome).toBe("not_found");
		expect(data.note).toContain("1 件");
	});

	it("返信でないのに reply を指定したら、Discord を呼ばずに not_found", async () => {
		const { adapter, calls } = setup([]);
		const res = successOf(
			await read(
				adapter,
				{ message: "reply", index: 1 },
				context({ replyToMessageId: null }),
			),
		);
		expect(res.data).toMatchObject({ outcome: "not_found" });
		expect(calls).toHaveLength(0);
	});

	it("メッセージが 404 なら not_found", async () => {
		const { adapter } = setup([json({ code: 10008 }, 404)]);
		expect(successOf(await read(adapter)).data).toMatchObject({
			outcome: "not_found",
		});
	});
});

describe("取得の失敗", () => {
	const errorOf = (r: Result<CapabilityResponse, DomainError>) => {
		if (r.ok) throw new Error("失敗のはず");
		return r.error;
	};

	it("Discord が 403 なら直らない外部サービスの失敗", async () => {
		const { adapter } = setup([json({ code: 50013 }, 403)]);
		expect(errorOf(await read(adapter))).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: false,
		});
	});

	it("Discord が 429 なら RateLimited、5xx は再試行できる失敗", async () => {
		expect(errorOf(await read(setup([json({}, 429)]).adapter)).type).toBe(
			"RateLimited",
		);
		expect(errorOf(await read(setup([json({}, 503)]).adapter))).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: true,
		});
	});

	it("CDN が失敗する・繋がらない・遅いときは ExternalServiceUnavailable", async () => {
		for (const step of [
			new Response("", { status: 404 }),
			new Error("down"),
			"hang" as const,
		]) {
			const { adapter } = setup([
				message([{ filename: "a.txt", content_type: "text/plain", size: 1 }]),
				step,
			]);
			expect(errorOf(await read(adapter)).type).toBe(
				"ExternalServiceUnavailable",
			);
		}
	});

	it("Discord の CDN 以外の URL は取りに行かない", async () => {
		const { adapter, calls } = setup([
			message([
				{
					filename: "a.txt",
					content_type: "text/plain",
					size: 1,
					url: "https://evil.example/a.txt",
				},
			]),
		]);
		expect(errorOf(await read(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
		expect(calls).toHaveLength(1);
	});

	it("応答が想定と違えば ExternalServiceUnavailable", async () => {
		expect(errorOf(await read(setup([json({ nope: 1 })]).adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});

	it("未知の道具名は ValidationFailed", async () => {
		const { adapter } = setup([]);
		const r = await adapter.execute({
			requestId: "r",
			tool: "other",
			input: {},
			context: context(),
		});
		expect(errorOf(r).type).toBe("ValidationFailed");
	});
});
