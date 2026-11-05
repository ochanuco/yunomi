import { describe, expect, it, vi } from "vitest";
import { createDiscordRest, splitMessage } from "./discord-rest.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("splitMessage", () => {
	it("上限以下はそのまま、超えたら改行で切る", () => {
		expect(splitMessage("abc", 10)).toEqual(["abc"]);
		expect(splitMessage("aaaa\nbbbb\ncc", 10)).toEqual(["aaaa\nbbbb", "cc"]);
		expect(splitMessage("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
	});
});

describe("createDiscordRest", () => {
	it("Bot トークンで認証し、フォーラム投稿を立てる。メンションは鳴らさない", async () => {
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				json({ id: "t1", name: "件名", parent_id: "f1" }),
		);
		const api = createDiscordRest({ token: "tok", fetch });
		const r = await api.createForumPost("f1", {
			name: "件名",
			content: "本文",
			tagIds: ["tag1"],
		});
		expect(r).toEqual({ ok: true, value: { threadId: "t1" } });
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://discord.com/api/v10/channels/f1/threads");
		expect(init?.headers).toMatchObject({ authorization: "Bot tok" });
		expect(JSON.parse(String(init?.body))).toEqual({
			name: "件名",
			applied_tags: ["tag1"],
			message: { content: "本文", allowed_mentions: { parse: [] } },
		});
	});

	it("ファイルは multipart で最後の 1 件にだけ付け、本文は payload_json に入れる", async () => {
		let n = 0;
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				json({ id: `m${++n}` }),
		);
		const api = createDiscordRest({ token: "tok", fetch });
		const r = await api.send("c1", `${"a".repeat(1999)}\nbb`, "r1", [
			{ name: "a.png", contentType: "image/png", data: new Uint8Array([1, 2]) },
		]);
		expect(r).toEqual({ ok: true, value: { messageIds: ["m1", "m2"] } });
		const [first, last] = fetch.mock.calls.map(([, init]) => init);
		expect(JSON.parse(String(first?.body))).toMatchObject({
			message_reference: { message_id: "r1" },
		});
		const form = last?.body;
		expect(form).toBeInstanceOf(FormData);
		if (!(form instanceof FormData)) return;
		// boundary 付きの content-type は fetch に任せる
		expect(last?.headers).not.toHaveProperty("content-type");
		expect(JSON.parse(String(form.get("payload_json")))).toEqual({
			content: "bb",
			allowed_mentions: { parse: [] },
			attachments: [{ id: 0, filename: "a.png" }],
		});
		const file = form.get("files[0]");
		expect(file).toBeInstanceOf(File);
		expect(file instanceof File && file.name).toBe("a.png");
		expect(file instanceof File && file.type).toBe("image/png");
	});

	it("本文が空でもファイルがあれば 1 件送る", async () => {
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				json({ id: "m1" }),
		);
		const r = await createDiscordRest({ token: "t", fetch }).send(
			"c1",
			"",
			undefined,
			[{ name: "a.png", contentType: "image/png", data: new Uint8Array([1]) }],
		);
		expect(r).toEqual({ ok: true, value: { messageIds: ["m1"] } });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("履歴は古い順に並べ直し、表示名を優先する", async () => {
		const fetch = vi.fn(async () =>
			json([
				{
					id: "2",
					content: "b",
					author: { id: "u2", username: "bot", bot: true },
				},
				{
					id: "1",
					content: "a",
					author: { id: "u1", username: "x", global_name: "X" },
				},
			]),
		);
		const r = await createDiscordRest({ token: "t", fetch }).listMessages(
			"c",
			50,
		);
		expect(r.ok && r.value.map((m) => [m.id, m.authorName, m.isBot])).toEqual([
			["1", "X", false],
			["2", "bot", true],
		]);
	});

	it("長い本文は分けて送り、返信先は最初の 1 件だけに付ける", async () => {
		let n = 0;
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				json({ id: `sent${++n}` }),
		);
		const api = createDiscordRest({ token: "t", fetch });
		const long = `${"a".repeat(1990)}\n${"b".repeat(100)}`;
		expect(await api.send("c", long, "m1")).toEqual({
			ok: true,
			value: { messageIds: ["sent1", "sent2"] },
		});
		const bodies = fetch.mock.calls.map(([, init]) =>
			JSON.parse(String(init?.body)),
		);
		expect(bodies).toHaveLength(2);
		expect(bodies[0].message_reference.message_id).toBe("m1");
		expect(bodies[1].message_reference).toBeUndefined();
	});

	it("429 は短ければ 1 回だけ待ってやり直す。失敗は err で返す", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 429, headers: { "retry-after": "0" } }),
			)
			.mockResolvedValueOnce(json({ id: "me", username: "y" }));
		expect(await createDiscordRest({ token: "t", fetch }).me()).toEqual({
			ok: true,
			value: { id: "me" },
		});

		const down = vi.fn(async () => new Response(null, { status: 500 }));
		const r = await createDiscordRest({ token: "t", fetch: down }).getChannel(
			"c",
		);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});

	it("2xx 以外は状態とエラーコード・メッセージをログに残し、トークンは出さない", async () => {
		const logs: Record<string, unknown>[] = [];
		const logger = {
			debug: () => {},
			info: () => {},
			warn: (msg: string, fields?: Record<string, unknown>) => {
				logs.push({ msg, ...fields });
			},
			error: () => {},
		};
		const forbidden = vi.fn(async () =>
			json({ message: "Missing Permissions", code: 50013 }, 403),
		);
		const api = createDiscordRest({
			token: "secret-token",
			fetch: forbidden,
			logger,
		});
		const r = await api.setTags("t1", ["a"]);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(logs).toEqual([
			{
				msg: "discord request rejected",
				route: "PATCH /channels/t1",
				status: 403,
				code: 50013,
				message: "Missing Permissions",
			},
		]);
		expect(JSON.stringify(logs)).not.toContain("secret-token");

		const sent = await api.send("t1", "hi");
		expect(!sent.ok && sent.error.type).toBe("PermissionDenied");

		const notFound = vi.fn(async () =>
			json({ message: "Unknown Channel", code: 10003 }, 404),
		);
		const missing = await createDiscordRest({
			token: "t",
			fetch: notFound,
			logger,
		}).getChannel("x");
		expect(!missing.ok && missing.error.type).toBe(
			"ExternalServiceUnavailable",
		);
	});
});
