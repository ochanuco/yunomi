import type { DomainError, Result } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { workRequest } from "../definitions/work.ts";
import {
	createWorkingRequestsAdapter,
	discordMessageUrl,
} from "./working-requests.ts";

type Call = { url: string; init: RequestInit };
type Step = Response | Error;

const setup = (steps: Step[]) => {
	const calls: Call[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: String(input), init: init ?? {} });
		const step = steps.shift();
		if (step === undefined) throw new Error("想定外の fetch");
		if (step instanceof Error) throw step;
		return step;
	}) as typeof fetch;
	const adapter = createWorkingRequestsAdapter({
		fetch: fetchFn,
		baseUrl: "https://mizuya.example.test/",
		accessClientId: "id-1",
		accessClientSecret: "secret-1",
	});
	return { adapter, calls };
};

const context: CallContext = {
	partnerId: "yukarin",
	speakerId: "111",
	isOwner: true,
	guildId: "222",
	channelId: "333",
	sourceMessageId: "444",
	now: new Date("2026-11-22T03:00:00Z"),
};

const input = {
	title: "  README の手順を直す ",
	request: "yunomi の README のセットアップ手順を今の pnpm に合わせる。",
};

const run = (
	adapter: ReturnType<typeof setup>["adapter"],
	over: { input?: unknown; context?: Partial<CallContext> } = {},
) =>
	adapter.execute({
		requestId: "0190f0a0-0000-7000-8000-000000000001",
		tool: workRequest.name,
		input: over.input ?? input,
		context: { ...context, ...over.context },
	});

const successOf = (
	r: Result<CapabilityResponse, DomainError>,
): CapabilityResponse => {
	if (!r.ok) throw new Error(`成功のはず: ${r.error.message}`);
	return r.value;
};

const errorOf = (r: Result<CapabilityResponse, DomainError>): DomainError => {
	if (r.ok) throw new Error("失敗のはず");
	return r.error;
};

const accepted = () => Response.json({ id: "w-1" }, { status: 202 });

describe("work_request", () => {
	it("Access のヘッダを付けて /working/requests に依頼を POST する", async () => {
		const { adapter, calls } = setup([accepted()]);
		const res = successOf(await run(adapter));

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe("https://mizuya.example.test/working/requests");
		expect(call?.init.method).toBe("POST");
		expect(call?.init.headers).toEqual({
			"CF-Access-Client-Id": "id-1",
			"CF-Access-Client-Secret": "secret-1",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(call?.init.body))).toEqual({
			request_id: "0190f0a0-0000-7000-8000-000000000001",
			partner: "yukarin",
			title: "README の手順を直す",
			request: "yunomi の README のセットアップ手順を今の pnpm に合わせる。",
			requested_by: "111",
			context_url: "https://discord.com/channels/222/333/444",
		});
		expect(res.data).toMatchObject({ status: "accepted" });
		expect(String((res.data as { note: string }).note)).toContain("今の仕事");
		expect(res.summary).not.toContain("README");
	});

	it("VC の発話から頼まれたときは context_url を null にする", async () => {
		const { adapter, calls } = setup([accepted()]);
		await run(adapter, { context: { sourceMessageId: "voice:evt-1" } });
		expect(JSON.parse(String(calls[0]?.init.body)).context_url).toBeNull();
	});

	it.each([
		[400, "ValidationFailed", false],
		[401, "PermissionDenied", false],
		[403, "PermissionDenied", false],
		[405, "ExternalServiceUnavailable", false],
		[429, "RateLimited", true],
		[500, "ExternalServiceUnavailable", true],
	])("%i は %s（retryable %s）", async (status, type, retryable) => {
		const { adapter } = setup([
			Response.json({ error: "x" }, { status: status as number }),
		]);
		const e = errorOf(await run(adapter));
		expect(e.type).toBe(type);
		expect(e.retryable).toBe(retryable);
	});

	it("接続できないときは再試行できる失敗", async () => {
		const { adapter } = setup([new TypeError("network")]);
		const e = errorOf(await run(adapter));
		expect(e).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: true,
		});
	});

	it.each([
		["件名が空", { ...input, title: "  " }],
		["件名に改行", { ...input, title: "直す\nこと" }],
		["件名が 101 字", { ...input, title: "あ".repeat(101) }],
		["本文が空", { ...input, request: "" }],
		["本文が 2001 字", { ...input, request: "あ".repeat(2001) }],
	])("%s なら送らずに ValidationFailed", async (_, bad) => {
		const { adapter, calls } = setup([]);
		expect(errorOf(await run(adapter, { input: bad })).type).toBe(
			"ValidationFailed",
		);
		expect(calls).toHaveLength(0);
	});

	it("定義は category work_request で、オーナーのターンにだけ出す", () => {
		expect(workRequest.category).toBe("work_request");
		expect(workRequest.ownerOnly).toBe(true);
	});
});

describe("discordMessageUrl", () => {
	it("サーバーが分からなければ null", () => {
		const { guildId: _omitted, ...rest } = context;
		expect(discordMessageUrl(rest)).toBeNull();
	});
});
