import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-support.ts";
import { credentialsPathOf, runMemoryCli } from "./cli.ts";

const SECRET = "very-secret-value";

const setup = () => {
	const dir = tempDir();
	writeFileSync(
		credentialsPathOf(dir),
		JSON.stringify({
			url: "https://worker.example/",
			client_id: "cid",
			client_secret: SECRET,
			discord_user_id: "owner-1",
			partner_id: "yukarin",
		}),
	);
	return { YUNOMI_STATE_DIR: dir };
};

const respond = (status: number, body: unknown) =>
	vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);

describe("runMemoryCli", () => {
	it("read は持ち主の記憶を GET し、応答をそのまま出す", async () => {
		const env = setup();
		const f = respond(200, { facts: [], episodes: [], open_loops: [] });
		const out = await runMemoryCli(["read"], env, f as typeof fetch);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			facts: [],
			episodes: [],
			open_loops: [],
		});
		const [url, init] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/yukarin/working/memory?discord_user_id=owner-1",
		);
		expect(init?.headers).toMatchObject({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": SECRET,
		});
	});

	it("YUNOMI_PARTNER があればそのパートナーの記憶を読む", async () => {
		const env = { ...setup(), YUNOMI_PARTNER: "akarin" };
		const f = respond(200, { facts: [], episodes: [], open_loops: [] });
		await runMemoryCli(["read"], env, f as typeof fetch);
		const [url] = f.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://worker.example/v1/partners/akarin/working/memory?discord_user_id=owner-1",
		);
	});

	it("write は 1 行を POST する", async () => {
		const env = setup();
		const f = respond(201, { id: "n1" });
		const out = await runMemoryCli(
			["write", "--kind", "decided", "--summary", " 朝会は 9 時 "],
			env,
			f as typeof fetch,
		);
		expect(out.code).toBe(0);
		const [, init] = f.mock.calls[0] ?? [];
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual({
			discord_user_id: "owner-1",
			kind: "decided",
			summary: "朝会は 9 時",
		});
	});

	it("書き方が違えば呼ばずに断る", async () => {
		const env = setup();
		const f = respond(201, {});
		for (const argv of [
			["write", "--kind", "other", "--summary", "x"],
			["write", "--kind", "done", "--summary", "a\nb"],
			["write", "--kind", "done", "--summary", "あ".repeat(201)],
			["write", "--kind", "done"],
			["delete"],
			["read", "extra"],
		]) {
			expect((await runMemoryCli(argv, env, f as typeof fetch)).code).toBe(2);
		}
		expect(f).not.toHaveBeenCalled();
	});

	it("失敗しても接続情報を出さない", async () => {
		const env = setup();
		const out = await runMemoryCli(
			["read"],
			env,
			respond(403, { error: "forbidden" }) as typeof fetch,
		);
		expect(out.code).toBe(1);
		expect(out.stderr).toContain("403");
		expect(out.stderr).toContain("forbidden");
		expect(`${out.stdout}${out.stderr}`).not.toContain(SECRET);
		expect(`${out.stdout}${out.stderr}`).not.toContain("cid");
	});

	it("接続情報がなければ呼ばない", async () => {
		const f = respond(200, {});
		const out = await runMemoryCli(
			["read"],
			{ YUNOMI_STATE_DIR: tempDir() },
			f as typeof fetch,
		);
		expect(out.code).toBe(1);
		expect(f).not.toHaveBeenCalled();
	});
});
