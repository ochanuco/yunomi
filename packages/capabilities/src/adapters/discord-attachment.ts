import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	rateLimited,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type {
	CapabilityAdapter,
	CapabilityResponse,
	ToolImage,
} from "../contract.ts";
import {
	type ReadAttachmentInput,
	readAttachment,
} from "../definitions/attachment.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "discord_attachment";
const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/yunomi, 0)";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Claude API が 1 枚の画像に認める上限。 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 200 * 1024;
export const MAX_TEXT_CHARS = 20_000;

export type DiscordAttachmentDeps = {
	fetch: typeof fetch;
	botToken: string;
	/** Discord への fetch 1 回あたりの待ち時間の上限（ms）。既定は 10 秒。 */
	timeoutMs?: number;
};

const MessageResponse = v.object({
	attachments: v.array(
		v.object({
			filename: v.string(),
			content_type: v.nullish(v.string()),
			size: v.number(),
			url: v.string(),
		}),
	),
});

const IMAGE_BY_EXTENSION: Readonly<Record<string, ToolImage["mediaType"]>> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
	[
		"txt md markdown rst log csv tsv json jsonc yaml yml toml ini conf xml html css",
		"js mjs cjs jsx ts mts cts tsx py rb go rs java kt swift c h cpp hpp cs php",
		"sh bash zsh sql diff patch tex",
	]
		.join(" ")
		.split(" "),
);

// Discord が付ける content_type のうち、拡張子が無くてもテキストと分かるもの。
const TEXT_APPLICATION_TYPES: ReadonlySet<string> = new Set([
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
	"application/toml",
	"application/javascript",
	"application/typescript",
	"application/x-sh",
]);

const extensionOf = (filename: string): string => {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
};

type Kind = "image" | "text";

// content_type と拡張子の両方から種別を決める。食い違うものと、どちらからも分からないものは null。
const classify = (
	filename: string,
	contentType: string | null | undefined,
): Kind | null => {
	const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	const ext = extensionOf(filename);
	const extImage = IMAGE_BY_EXTENSION[ext];
	if (type.startsWith("image/")) {
		return type === extImage ? "image" : null;
	}
	if (type.startsWith("text/") || TEXT_APPLICATION_TYPES.has(type)) {
		return extImage === undefined ? "text" : null;
	}
	// Discord は content_type を付けないことも、ソースコードに octet-stream を付けることもある。
	if (type === "" || type === "application/octet-stream") {
		if (extImage !== undefined) return "image";
		return TEXT_EXTENSIONS.has(ext) ? "text" : null;
	}
	return null;
};

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
	magic.every((b, i) => bytes[at + i] === b);

// 宣言と中身が違う画像を Claude API に渡すと、ターン全体が失敗する。中身から種別を決める。
const sniffImage = (bytes: Uint8Array): ToolImage["mediaType"] | null => {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
	) {
		return "image/webp";
	}
	return null;
};

const toBase64 = (bytes: Uint8Array): string => {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
};

// サロゲートペアの途中で切ると文字化けするので、上限の位置が前半なら 1 つ手前で切る。
const truncateText = (text: string): { text: string; truncated: boolean } => {
	if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
	const last = text.charCodeAt(MAX_TEXT_CHARS - 1);
	const end =
		last >= 0xd800 && last <= 0xdbff ? MAX_TEXT_CHARS - 1 : MAX_TEXT_CHARS;
	return { text: text.slice(0, end), truncated: true };
};

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

const isDiscordCdn = (url: string): boolean => {
	try {
		const u = new URL(url);
		return (
			u.protocol === "https:" &&
			(u.hostname === "cdn.discordapp.com" ||
				u.hostname === "media.discordapp.net")
		);
	} catch {
		return false;
	}
};

type Outcome = "unsupported_type" | "too_large" | "not_found";

// 読めない理由はドメインエラーではなく結果として返し、モデルが相手へ説明できるようにする。
const unreadable = (
	outcome: Outcome,
	note: string,
	extra: Record<string, unknown> = {},
): Result<CapabilityResponse, DomainError> =>
	ok({ data: { outcome, note, ...extra }, summary: outcome });

/**
 * Discord のメッセージの添付ファイルを読む adapter。内容は返すだけで、どこにも保存しない。
 * メッセージを REST で取り直して、そのたびに署名つきの URL を得る（保存した URL は期限が切れる）。
 */
export const createDiscordAttachmentAdapter = (
	deps: DiscordAttachmentDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const guarded = async (
		url: string,
		init: RequestInit,
		label: string,
	): Promise<Result<Response, DomainError>> => {
		try {
			return ok(
				await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
			);
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? `${label}の応答がタイムアウトした`
						: `${label}に接続できない`,
				),
			);
		}
	};

	// 上限を超えたら読むのをやめる。Content-Length が無い・偽りでも、メモリに載せる量を抑える。
	const readLimited = async (
		res: Response,
		limit: number,
	): Promise<Uint8Array | "too_large" | null> => {
		const reader = res.body?.getReader();
		if (!reader) return null;
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) {
				await reader.cancel().catch(() => undefined);
				return "too_large";
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	};

	const run = async (
		input: ReadAttachmentInput,
		context: {
			channelId: string;
			sourceMessageId: string;
			replyToMessageId?: string | null;
		},
	): Promise<Result<CapabilityResponse, DomainError>> => {
		const messageId =
			input.message === "current"
				? context.sourceMessageId
				: (context.replyToMessageId ?? null);
		if (messageId === null) {
			return unreadable("not_found", "このメッセージは返信ではない。");
		}

		const msgRes = await guarded(
			`${API_BASE}/channels/${context.channelId}/messages/${messageId}`,
			{
				headers: {
					authorization: `Bot ${deps.botToken}`,
					"user-agent": USER_AGENT,
				},
			},
			"Discord",
		);
		if (!msgRes.ok) return msgRes;
		const res = msgRes.value;
		if (res.status === 404) {
			return unreadable("not_found", "メッセージが見つからない。消えている。");
		}
		if (res.status === 429) return err(rateLimited({ retryAfterMs: null }));
		if (res.status === 401 || res.status === 403) {
			return err(unavailable(`Discord が ${res.status} を返した`, false));
		}
		if (!res.ok) {
			return err(
				unavailable(`Discord が ${res.status} を返した`, res.status >= 500),
			);
		}
		const parsed = v.safeParse(
			MessageResponse,
			await res.json().catch(() => null),
		);
		if (!parsed.success) {
			return err(unavailable("Discord の応答が想定と違う"));
		}

		const attachments = parsed.output.attachments;
		const target = attachments[input.index - 1];
		if (!target) {
			return unreadable(
				"not_found",
				`その番号の添付はない。このメッセージの添付は ${attachments.length} 件。`,
			);
		}

		const meta = {
			filename: target.filename,
			content_type: target.content_type ?? null,
			size: target.size,
		};
		const kind = classify(target.filename, target.content_type);
		if (kind === null) {
			return unreadable(
				"unsupported_type",
				"読めない形式。読めるのは画像（jpeg・png・gif・webp）とテキストファイルだけ。",
				meta,
			);
		}
		const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
		const tooLarge = () =>
			unreadable(
				"too_large",
				`大きすぎて読めない。上限は${kind === "image" ? "画像 5MB" : "テキスト 200KB"}。`,
				meta,
			);
		if (target.size > limit) return tooLarge();
		if (!isDiscordCdn(target.url)) {
			return err(unavailable("添付の URL が Discord の CDN ではない", false));
		}

		const fileRes = await guarded(target.url, {}, "Discord の CDN");
		if (!fileRes.ok) return fileRes;
		if (!fileRes.value.ok) {
			return err(
				unavailable(
					`添付の取得で ${fileRes.value.status} が返った`,
					fileRes.value.status >= 500,
				),
			);
		}
		const bytes = await readLimited(fileRes.value, limit).catch(() => null);
		if (bytes === "too_large") return tooLarge();
		if (bytes === null) return err(unavailable("添付の本文を読めない"));

		if (kind === "image") {
			const mediaType = sniffImage(bytes);
			if (mediaType === null) {
				return unreadable(
					"unsupported_type",
					"画像として読めない。中身が jpeg・png・gif・webp ではない。",
					meta,
				);
			}
			return ok({
				data: { outcome: "read", kind: "image", ...meta },
				images: [{ mediaType, data: toBase64(bytes) }],
				summary: `画像の添付を読んだ（${target.filename}、${mediaType}、${bytes.length}B）`,
			});
		}

		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: false,
			}).decode(bytes);
		} catch {
			return unreadable(
				"unsupported_type",
				"UTF-8 のテキストとして読めない。",
				meta,
			);
		}
		const { text, truncated } = truncateText(decoded);
		return ok({
			data: {
				outcome: "read",
				kind: "text",
				...meta,
				truncated,
				...(truncated
					? {
							note: `先頭 ${MAX_TEXT_CHARS} 文字だけを返した。続きは読めていない。`,
						}
					: {}),
				text,
			},
			summary: `テキストの添付を読んだ（${target.filename}、${bytes.length}B${truncated ? "、途中まで" : ""}）`,
		});
	};

	return {
		tools: [readAttachment],
		async execute(request) {
			if (request.tool !== readAttachment.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(readAttachment, request.input);
			return input.ok ? run(input.value, request.context) : input;
		},
	};
};
