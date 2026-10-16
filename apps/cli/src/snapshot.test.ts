import { Encrypter } from "age-encryption";
import { describe, expect, it } from "vitest";
import { type Deps, run } from "./commands.ts";
import {
	syntheticSnapshot,
	TEST_AGE_IDENTITY,
	TEST_AGE_RECIPIENT,
} from "./fixtures.ts";

const SNAPSHOT_ID = "01990000-0000-7000-8000-000000000001";

const encrypt = async (value: unknown, recipient = TEST_AGE_RECIPIENT) => {
	const gz = new Uint8Array(
		await new Response(
			new Blob([JSON.stringify(value)])
				.stream()
				.pipeThrough(new CompressionStream("gzip")),
		).arrayBuffer(),
	);
	const e = new Encrypter();
	e.addRecipient(recipient);
	return e.encrypt(gz);
};

type Call = { method: string; url: URL; body: string | undefined };

const harness = (over: Partial<Deps> = {}, restoreStatus = 200) => {
	const out: string[] = [];
	const err: string[] = [];
	const calls: Call[] = [];
	const written: { path: string; bytes: Uint8Array }[] = [];
	const deps: Deps = {
		fetch: async (input, init) => {
			const url = new URL(input);
			const method = init?.method ?? "GET";
			calls.push({ method, url, body: init?.body as string | undefined });
			if (url.pathname.endsWith("/snapshots/restore")) {
				return Response.json(
					restoreStatus === 200
						? {
								snapshot_id: SNAPSHOT_ID,
								source_env: "production",
								counts: {
									entities: 1,
									external_identities: 1,
									facts: 0,
									memory_candidates: 0,
									open_loops: 0,
									interest_states: 0,
									opinion_states: 0,
									relationships: 0,
								},
							}
						: { error: "restore_disabled_in_production" },
					{ status: restoreStatus },
				);
			}
			if (url.pathname.endsWith(`/snapshots/${SNAPSHOT_ID}`)) {
				return new Response(await encrypt(syntheticSnapshot()));
			}
			if (url.pathname.endsWith("/snapshots") && method === "POST") {
				return Response.json({
					id: SNAPSHOT_ID,
					created_at: "2026-10-11T03:00:00.000Z",
					size: 10,
					schema_version: 1,
					env: "development",
				});
			}
			return Response.json({
				items: [
					{
						id: SNAPSHOT_ID,
						created_at: "2026-10-11T03:00:00.000Z",
						size: 10,
						schema_version: 1,
						env: "production",
					},
				],
			});
		},
		env: {
			YKM_DEV_URL: "https://yunomi-dev.example.test",
			YKM_PROD_URL: "https://yunomi.example.test",
			YKM_ACCESS_CLIENT_ID: "id",
			YKM_ACCESS_CLIENT_SECRET: "s",
			YKM_AGE_IDENTITY: TEST_AGE_IDENTITY,
		},
		out: (t) => out.push(t),
		err: (t) => err.push(t),
		now: () => new Date("2026-10-11T03:00:00Z"),
		sleep: async () => {},
		signal: new AbortController().signal,
		writeFile: async (path, bytes) => {
			written.push({ path, bytes });
		},
		...over,
	};
	return { deps, out, err, calls, written };
};

describe("ykm snapshot", () => {
	it("list は一覧を表で出す", async () => {
		const h = harness();
		expect(await run(["snapshot", "list", "--env", "prod"], h.deps)).toBe(0);
		expect(h.out.join("\n")).toContain(SNAPSHOT_ID);
		expect(h.calls[0]?.url.origin).toBe("https://yunomi.example.test");
	});

	it("create は POST する", async () => {
		const h = harness();
		expect(await run(["snapshot", "create"], h.deps)).toBe(0);
		expect(h.calls[0]?.method).toBe("POST");
	});

	it("pull は暗号化されたまま保存する", async () => {
		const h = harness();
		expect(
			await run(
				["snapshot", "pull", SNAPSHOT_ID, "--env", "prod", "-o", "x.age"],
				h.deps,
			),
		).toBe(0);
		expect(h.written).toHaveLength(1);
		expect(h.written[0]?.path).toBe("x.age");
		const head = new TextDecoder().decode(h.written[0]?.bytes.slice(0, 20));
		expect(head).toContain("age-encryption.org");
		expect(new TextDecoder().decode(h.written[0]?.bytes)).not.toContain(
			"alice",
		);
	});
});

describe("ykm snapshot seed", () => {
	const argv = [
		"snapshot",
		"seed",
		SNAPSHOT_ID,
		"--from",
		"prod",
		"--to",
		"dev",
	];

	it("prod から取得 → 手元で復号 → 検証 → dev の restore に送る", async () => {
		const h = harness();
		expect(await run(argv, h.deps)).toBe(0);

		expect(
			h.calls.map((c) => [c.method, c.url.origin, c.url.pathname]),
		).toEqual([
			[
				"GET",
				"https://yunomi.example.test",
				`/admin/api/partners/yukarin/snapshots/${SNAPSHOT_ID}`,
			],
			[
				"POST",
				"https://yunomi-dev.example.test",
				"/admin/api/partners/yukarin/snapshots/restore",
			],
		]);
		expect(JSON.parse(h.calls[1]?.body ?? "{}")).toEqual(syntheticSnapshot());
		// 平文はディスクに書かない
		expect(h.written).toEqual([]);
		expect(h.out.join("\n")).toContain("元 env: production");
	});

	it("--to prod は拒否し、通信しない", async () => {
		const h = harness();
		expect(
			await run(
				["snapshot", "seed", SNAPSHOT_ID, "--from", "dev", "--to", "prod"],
				h.deps,
			),
		).toBe(2);
		expect(h.calls).toEqual([]);
	});

	it("--to を省略しても、--from と --to が同じでも拒否する", async () => {
		const h = harness();
		expect(
			await run(["snapshot", "seed", SNAPSHOT_ID, "--from", "prod"], h.deps),
		).toBe(2);
		expect(
			await run(
				["snapshot", "seed", SNAPSHOT_ID, "--from", "dev", "--to", "dev"],
				h.deps,
			),
		).toBe(2);
		expect(h.calls).toEqual([]);
	});

	it("YKM_AGE_IDENTITY が無ければ取得もしない", async () => {
		const h = harness({
			env: { YKM_ACCESS_CLIENT_ID: "id", YKM_ACCESS_CLIENT_SECRET: "s" },
		});
		expect(await run(argv, h.deps)).toBe(1);
		expect(h.calls).toEqual([]);
	});

	it("別の鍵で暗号化されていたら復号に失敗し、restore しない", async () => {
		const h = harness({
			env: {
				YKM_DEV_URL: "https://yunomi-dev.example.test",
				YKM_PROD_URL: "https://yunomi.example.test",
				YKM_ACCESS_CLIENT_ID: "id",
				YKM_ACCESS_CLIENT_SECRET: "s",
				YKM_AGE_IDENTITY:
					"AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQSZ0MQ0",
			},
		});
		expect(await run(argv, h.deps)).toBe(1);
		expect(h.calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("復号した内容が契約に合わなければ restore しない", async () => {
		const h = harness({
			fetch: async () =>
				new Response(
					await encrypt({ ...syntheticSnapshot(), schema_version: 9 }),
				),
		});
		expect(await run(argv, h.deps)).toBe(1);
		expect(h.err.join("\n")).toContain("admin-contract");
	});

	it("restore が拒否されたらエラーで終わる", async () => {
		const h = harness({}, 403);
		expect(await run(argv, h.deps)).toBe(1);
		expect(h.err.join("\n")).toContain("restore_disabled_in_production");
	});
});
