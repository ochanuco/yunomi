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

const API = "https://discord.com/api/v10";
/** Discord のメッセージ本文の上限。 */
export const MESSAGE_LIMIT = 2000;
/** フォーラム投稿の件名の上限。 */
export const THREAD_NAME_LIMIT = 100;

const userSchema = v.object({
	id: v.string(),
	username: v.string(),
	global_name: v.nullish(v.string()),
	bot: v.optional(v.boolean()),
});
const messageSchema = v.object({
	id: v.string(),
	content: v.string(),
	author: userSchema,
});
const sentSchema = v.object({ id: v.string() });
const channelSchema = v.object({
	id: v.string(),
	name: v.nullish(v.string()),
	parent_id: v.nullish(v.string()),
	applied_tags: v.optional(v.array(v.string())),
	available_tags: v.optional(
		v.array(v.object({ id: v.string(), name: v.string() })),
	),
});

export type ChannelInfo = {
	id: string;
	name: string | null;
	parentId: string | null;
	appliedTagIds: string[];
	availableTags: { id: string; name: string }[];
};

export type PostedMessage = {
	id: string;
	authorId: string;
	authorName: string;
	isBot: boolean;
	content: string;
};

export type DiscordApi = {
	me: () => Promise<Result<{ id: string }, DomainError>>;
	getChannel: (id: string) => Promise<Result<ChannelInfo, DomainError>>;
	getMessage: (
		channelId: string,
		messageId: string,
	) => Promise<Result<PostedMessage, DomainError>>;
	/** 古い順に返す。 */
	listMessages: (
		channelId: string,
		limit: number,
	) => Promise<Result<PostedMessage[], DomainError>>;
	createForumPost: (
		forumId: string,
		post: { name: string; content: string; tagIds: string[] },
	) => Promise<Result<{ threadId: string }, DomainError>>;
	/** 上限を超える本文は分けて送る。replyTo は最初の 1 件だけに付ける。送ったメッセージの ID を順に返す。 */
	send: (
		channelId: string,
		content: string,
		replyTo?: string,
	) => Promise<Result<{ messageIds: string[] }, DomainError>>;
	setTags: (
		threadId: string,
		tagIds: string[],
	) => Promise<Result<void, DomainError>>;
};

export type DiscordRestOptions = {
	token: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

const toPosted = (m: v.InferOutput<typeof messageSchema>): PostedMessage => ({
	id: m.id,
	authorId: m.author.id,
	authorName: m.author.global_name ?? m.author.username,
	isBot: m.author.bot ?? false,
	content: m.content,
});

const toChannel = (c: v.InferOutput<typeof channelSchema>): ChannelInfo => ({
	id: c.id,
	name: c.name ?? null,
	parentId: c.parent_id ?? null,
	appliedTagIds: c.applied_tags ?? [],
	availableTags: c.available_tags ?? [],
});

/** 改行を優先して上限以下に切り分ける。 */
export const splitMessage = (text: string, limit = MESSAGE_LIMIT): string[] => {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const cut = rest.lastIndexOf("\n", limit);
		const at = cut > 0 ? cut : limit;
		chunks.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n/, "");
	}
	if (rest.trim() !== "") chunks.push(rest);
	return chunks;
};

export const createDiscordRest = (opts: DiscordRestOptions): DiscordApi => {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 15_000;

	const call = async <T>(
		method: string,
		path: string,
		schema: v.GenericSchema<unknown, T> | null,
		body?: unknown,
		retried = false,
	): Promise<Result<T | undefined, DomainError>> => {
		let res: Response;
		try {
			res = await doFetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bot ${opts.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			return err(externalServiceUnavailable({ service: "discord" }));
		}
		if (res.status === 429) {
			const retryAfter = Number(res.headers.get("retry-after") ?? "1");
			const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000;
			// 投稿ごとに直列なので短い待ちなら 1 回だけ待ってやり直す
			if (!retried && waitMs <= 10_000) {
				await new Promise((r) => setTimeout(r, waitMs));
				return call(method, path, schema, body, true);
			}
			return err(rateLimited({ retryAfterMs: waitMs }));
		}
		if (!res.ok) {
			return err(externalServiceUnavailable({ service: "discord" }));
		}
		if (schema === null) return ok(undefined);
		const parsed = v.safeParse(schema, await res.json().catch(() => null));
		if (!parsed.success) {
			return err(
				validationFailed({ issues: parsed.issues.map((i) => i.message) }),
			);
		}
		return ok(parsed.output);
	};

	const callJson = async <T>(
		method: string,
		path: string,
		schema: v.GenericSchema<unknown, T>,
		body?: unknown,
	): Promise<Result<T, DomainError>> =>
		(await call(method, path, schema, body)) as Result<T, DomainError>;

	const noMentions = { parse: [] as string[] };

	return {
		me: async () => {
			const r = await callJson("GET", "/users/@me", userSchema);
			return r.ok ? ok({ id: r.value.id }) : r;
		},
		getChannel: async (id) => {
			const r = await callJson("GET", `/channels/${id}`, channelSchema);
			return r.ok ? ok(toChannel(r.value)) : r;
		},
		getMessage: async (channelId, messageId) => {
			const r = await callJson(
				"GET",
				`/channels/${channelId}/messages/${messageId}`,
				messageSchema,
			);
			return r.ok ? ok(toPosted(r.value)) : r;
		},
		listMessages: async (channelId, limit) => {
			const r = await callJson(
				"GET",
				`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`,
				v.array(messageSchema),
			);
			// API は新しい順に返す
			return r.ok ? ok(r.value.map(toPosted).reverse()) : r;
		},
		createForumPost: async (forumId, post) => {
			const r = await callJson(
				"POST",
				`/channels/${forumId}/threads`,
				channelSchema,
				{
					name: post.name.slice(0, THREAD_NAME_LIMIT),
					applied_tags: post.tagIds,
					message: {
						content: post.content.slice(0, MESSAGE_LIMIT),
						allowed_mentions: noMentions,
					},
				},
			);
			return r.ok ? ok({ threadId: r.value.id }) : r;
		},
		send: async (channelId, content, replyTo) => {
			const chunks = splitMessage(content);
			const messageIds: string[] = [];
			for (const [i, chunk] of chunks.entries()) {
				const r = await callJson(
					"POST",
					`/channels/${channelId}/messages`,
					sentSchema,
					{
						content: chunk,
						allowed_mentions: noMentions,
						...(i === 0 && replyTo
							? {
									message_reference: {
										message_id: replyTo,
										fail_if_not_exists: false,
									},
								}
							: {}),
					},
				);
				if (!r.ok) return r;
				messageIds.push(r.value.id);
			}
			return ok({ messageIds });
		},
		setTags: async (threadId, tagIds) => {
			const r = await call("PATCH", `/channels/${threadId}`, null, {
				applied_tags: tagIds,
			});
			return r.ok ? ok(undefined) : r;
		},
	};
};
