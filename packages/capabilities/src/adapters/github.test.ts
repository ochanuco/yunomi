import type { DomainError, Result } from "@yunomi/core";
import { toModelJson } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { githubRead } from "../definitions/github.ts";
import { createGithubAdapter } from "./github.ts";

type Call = { url: URL; init: RequestInit };
type Step = Response | Error;

const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const setup = (steps: Step[], defaultRepo?: string) => {
	const calls: Call[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: new URL(String(input)), init: init ?? {} });
		const step = steps.shift();
		if (step === undefined) throw new Error("想定外の fetch");
		if (step instanceof Error) throw step;
		return step;
	}) as typeof fetch;
	const adapter = createGithubAdapter({
		fetch: fetchFn,
		token: "tok-1",
		...(defaultRepo === undefined ? {} : { defaultRepo }),
	});
	return { adapter, calls };
};

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now: new Date("2026-10-19T03:00:00Z"),
};

const read = (
	adapter: ReturnType<typeof setup>["adapter"],
	input: unknown = { repo: "ochanuco/yunomi", number: 176 },
) =>
	adapter.execute({
		requestId: "req-1",
		tool: githubRead.name,
		input,
		context,
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

const issue = (over: Record<string, unknown> = {}) => ({
	number: 176,
	title: "GitHub を読む道具を足す",
	state: "open",
	labels: [{ name: "enhancement" }, { name: "capability" }],
	user: { login: "ochanuco" },
	created_at: "2026-10-18T01:00:00Z",
	updated_at: "2026-10-19T02:30:00Z",
	body: "本文です",
	comments: 3,
	html_url: "https://github.com/ochanuco/yunomi/issues/176",
	...over,
});

const pr = (mergedAt: string | null, over: Record<string, unknown> = {}) =>
	issue({
		number: 162,
		state: mergedAt === null ? "open" : "closed",
		html_url: "https://github.com/ochanuco/yunomi/pull/162",
		pull_request: { merged_at: mergedAt },
		...over,
	});

describe("github_read", () => {
	it("道具は github_read だけ", () => {
		expect(setup([]).adapter.tools).toEqual([githubRead]);
	});

	it("open の Issue を返し、リクエストの URL とヘッダーが仕様どおり", async () => {
		const { adapter, calls } = setup([json(issue())]);
		const out = successOf(await read(adapter));

		expect(out.data).toEqual({
			kind: "issue",
			repo: "ochanuco/yunomi",
			number: 176,
			title: "GitHub を読む道具を足す",
			state: "open",
			labels: ["enhancement", "capability"],
			author: "ochanuco",
			created_at: new Date("2026-10-18T01:00:00Z"),
			updated_at: new Date("2026-10-19T02:30:00Z"),
			body: "本文です",
			body_truncated: false,
			comments: 3,
			url: "https://github.com/ochanuco/yunomi/issues/176",
		});
		const [call] = calls;
		expect(call?.url.href).toBe(
			"https://api.github.com/repos/ochanuco/yunomi/issues/176",
		);
		expect(call?.init.method).toBe("GET");
		const headers = new Headers(call?.init.headers);
		expect(headers.get("authorization")).toBe("Bearer tok-1");
		expect(headers.get("accept")).toBe("application/vnd.github+json");
		expect(headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(headers.get("user-agent")).toBe("yunomi");
	});

	it("日時はモデルに JST の書式で渡る", async () => {
		const { adapter } = setup([json(issue())]);
		const out = successOf(await read(adapter));
		const model = JSON.parse(toModelJson(out.data));
		expect(model.created_at).toBe("2026-10-18 10:00 JST");
		expect(model.updated_at).toBe("2026-10-19 11:30 JST");
	});

	it("closed の Issue は state が closed", async () => {
		const { adapter } = setup([json(issue({ state: "closed" }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ kind: "issue", state: "closed" });
	});

	it("open の PR は pull_request で state が open", async () => {
		const { adapter } = setup([json(pr(null))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ kind: "pull_request", state: "open" });
	});

	it("merged_at のある PR は merged", async () => {
		const { adapter } = setup([json(pr("2026-10-18T05:00:00Z"))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ kind: "pull_request", state: "merged" });
	});

	it("閉じただけでマージされていない PR は closed", async () => {
		const { adapter } = setup([json(pr(null, { state: "closed" }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ kind: "pull_request", state: "closed" });
	});

	it("本文は 1,500 文字で切り詰め、切り詰めたことが分かる", async () => {
		const { adapter } = setup([json(issue({ body: "あ".repeat(1_501) }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			body: "あ".repeat(1_500),
			body_truncated: true,
		});
	});

	it("ちょうど 1,500 文字なら切り詰めない", async () => {
		const { adapter } = setup([json(issue({ body: "a".repeat(1_500) }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			body: "a".repeat(1_500),
			body_truncated: false,
		});
	});

	it("本文が null なら空として扱う", async () => {
		const { adapter } = setup([json(issue({ body: null }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ body: "", body_truncated: false });
	});

	it("repo を省略すると既定の repo で読む", async () => {
		const { adapter, calls } = setup([json(issue())], "ochanuco/yunomi");
		const out = successOf(await read(adapter, { number: 176 }));
		expect(calls[0]?.url.pathname).toBe("/repos/ochanuco/yunomi/issues/176");
		expect(out.data).toMatchObject({ repo: "ochanuco/yunomi" });
	});

	it("repo を指定すれば既定より優先する", async () => {
		const { adapter, calls } = setup([json(issue())], "ochanuco/yunomi");
		successOf(await read(adapter, { repo: "octo/hello.world", number: 5 }));
		expect(calls[0]?.url.pathname).toBe("/repos/octo/hello.world/issues/5");
	});

	it("repo を省略して既定もなければ、fetch せずに ValidationFailed", async () => {
		const { adapter, calls } = setup([]);
		const e = errorOf(await read(adapter, { number: 1 }));
		expect(e.type).toBe("ValidationFailed");
		expect(calls).toHaveLength(0);
	});

	it.each([
		["owner だけ", { repo: "ochanuco", number: 1 }],
		["パスを含む", { repo: "a/b/c", number: 1 }],
		["不正な文字", { repo: "a/b c", number: 1 }],
		["repo 名が ..", { repo: "a/..", number: 1 }],
		["番号が 0", { number: 0 }],
		["番号が小数", { number: 1.5 }],
		["番号が文字列", { number: "1" }],
	])("入力が不正（%s）なら fetch せずに ValidationFailed", async (_, input) => {
		const { adapter, calls } = setup([]);
		const e = errorOf(await read(adapter, input));
		expect(e.type).toBe("ValidationFailed");
		expect(calls).toHaveLength(0);
	});

	it("404 は見つからないと分かる失敗で、retryable ではない", async () => {
		const { adapter } = setup([json({ message: "Not Found" }, 404)]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.message).toContain("見つからない");
		expect(e.retryable).toBe(false);
	});

	it("401 は retryable ではない失敗", async () => {
		const { adapter } = setup([json({ message: "Bad credentials" }, 401)]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.message).toContain("401");
		expect(e.retryable).toBe(false);
	});

	it("403 でレート制限を使い切っていれば RateLimited", async () => {
		const { adapter } = setup([
			json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
		]);
		expect(errorOf(await read(adapter)).type).toBe("RateLimited");
	});

	it("403 で枠が残っていれば権限の失敗", async () => {
		const { adapter } = setup([
			json({ message: "Forbidden" }, 403, { "x-ratelimit-remaining": "10" }),
		]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(false);
	});

	it("500 は retryable", async () => {
		const { adapter } = setup([json({}, 500)]);
		expect(errorOf(await read(adapter)).retryable).toBe(true);
	});

	it("ネットワーク失敗は retryable な ExternalServiceUnavailable", async () => {
		const { adapter } = setup([new TypeError("fetch failed")]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(true);
	});

	it("応答が想定と違えば ExternalServiceUnavailable", async () => {
		const { adapter } = setup([json({ unexpected: true })]);
		expect(errorOf(await read(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});

	it("summary は位置と種類だけで、タイトルや本文を含まない", async () => {
		const { adapter } = setup([json(pr(null, { body: "秘密の本文" }))]);
		const out = successOf(await read(adapter));
		expect(out.summary).toBe("ochanuco/yunomi#176 (pull_request) を取得");
		expect(out.summary).not.toContain("秘密");
		expect(out.summary).not.toContain("GitHub を読む");
	});

	it("未知の道具は ValidationFailed", async () => {
		const { adapter } = setup([]);
		const r = await adapter.execute({
			requestId: "req-1",
			tool: "other",
			input: {},
			context,
		});
		expect(errorOf(r).type).toBe("ValidationFailed");
	});
});
