import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { describe, expect, it } from "vitest";
import { openApprovalStore } from "./approval-store.ts";
import { claudeEnv, createClaudeCli, WORK_POLICY } from "./claude-cli.ts";
import type { ChannelInfo, DiscordApi } from "./discord-rest.ts";
import { createLedger } from "./guard/ledger.ts";
import { createIntake } from "./intake.ts";
import { silentLogger } from "./logger.ts";
import { openSessionStore } from "./session-store.ts";
import { tempDir } from "./test-support.ts";

const BOT = "bot";
const OWNER = "u1";
const FORUM = "forum";
const THREAD = "thread1";
const HOOK = join(import.meta.dirname, "guard", "hook.ts");

/**
 * Claude CLI のモック。決まったコマンドを Bash で実行しようとし、本物と同じく
 * 受け取った環境変数のまま PreToolUse hook（src/guard/hook.ts）を呼んで、通ったときだけ実行したことにする。
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
const sessionId = at("--session-id") ?? at("--resume");
readFileSync(0, "utf8");
const command = process.env.FAKE_COMMAND;
const hook = spawnSync(process.execPath, [process.env.FAKE_HOOK], {
	input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: process.env.YUNOMI_WORK_DIR }),
	env: process.env,
	encoding: "utf8",
});
const decision = hook.status === 0 ? JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision : "deny";
if (decision === "allow") appendFileSync(process.env.FAKE_EXECUTED, command + "\\n");
const result = decision === "allow" ? "push しました\\n状態: 完了" : "push には許可が要ります\\n状態: 完了";
process.stdout.write(JSON.stringify({ is_error: false, result, session_id: sessionId }));
`;

const fakeDiscord = () => {
	const channels = new Map<string, ChannelInfo>([
		[
			FORUM,
			{
				id: FORUM,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: [
					{ id: "tag-decide", name: "決めてほしい" },
					{ id: "tag-working", name: "作業中" },
					{ id: "tag-handoff", name: "引き継ぎ" },
					{ id: "tag-done", name: "完了" },
				],
			},
		],
		[
			THREAD,
			{
				id: THREAD,
				name: "main に push",
				parentId: FORUM,
				appliedTagIds: [],
				availableTags: [],
			},
		],
	]);
	const sent: { id: string; content: string }[] = [];
	const api: DiscordApi = {
		me: async () => ok({ id: BOT }),
		getChannel: async (id) => {
			const ch = channels.get(id);
			return ch
				? ok(ch)
				: err(externalServiceUnavailable({ service: "discord" }));
		},
		getMessage: async () =>
			err(externalServiceUnavailable({ service: "discord" })),
		listMessages: async () => ok([]),
		createForumPost: async () =>
			err(externalServiceUnavailable({ service: "discord" })),
		send: async (_channelId, content) => {
			const id = `sent${sent.length + 1}`;
			sent.push({ id, content });
			return ok({ messageIds: [id] });
		},
		setTags: async (threadId, tagIds) => {
			const ch = channels.get(threadId);
			if (ch) channels.set(threadId, { ...ch, appliedTagIds: tagIds });
			return ok(undefined);
		},
	};
	const tag = () => channels.get(THREAD)?.appliedTagIds;
	return { api, sent, tag };
};

let messageSeq = 0;
const say = (
	content: string,
	opts: { first?: boolean; replyTo?: string } = {},
): DiscordMessageCreatedEnvelope =>
	({
		event_id: `e${++messageSeq}`,
		payload: {
			guild_id: "g",
			channel_id: THREAD,
			message_id: opts.first ? THREAD : `m${messageSeq}`,
			author: { id: OWNER, display_name: "ちゃぬ", is_bot: false },
			content,
			mentions: [],
			reply_to_message_id: opts.replyTo ?? null,
			attachments: [],
		},
	}) as unknown as DiscordMessageCreatedEnvelope;

const setup = async (command: string) => {
	const root = tempDir();
	const stateDir = join(root, "state");
	const workDir = join(root, "work");
	const bin = join(root, "claude.mjs");
	const executed = join(root, "executed.txt");
	writeFileSync(bin, FAKE_CLAUDE);
	chmodSync(bin, 0o755);
	writeFileSync(executed, "");
	const d = fakeDiscord();
	const ledger = createLedger(join(stateDir, "guard"));
	let n = 0;
	const intake = createIntake({
		discord: d.api,
		claude: createClaudeCli({
			bin,
			cwd: root,
			systemPromptFile: join(root, "system.md"),
			timeoutMs: 30_000,
			policy: WORK_POLICY,
			env: {
				...claudeEnv(
					{ PATH: process.env.PATH, HOME: root },
					{ workDir, stateDir },
				),
				FAKE_HOOK: HOOK,
				FAKE_COMMAND: command,
				FAKE_EXECUTED: executed,
			},
		}),
		sessions: await openSessionStore(stateDir),
		approvals: await openApprovalStore(stateDir),
		ledger,
		botUserId: BOT,
		ownerUserIds: new Set([OWNER]),
		workTextChannelId: "text",
		workForumChannelId: FORUM,
		newSessionId: () => `s${++n}`,
		newGrantId: () => `g${n}`,
		logger: silentLogger,
	});
	const ran = () => readFileSync(executed, "utf8").split("\n").filter(Boolean);
	const events = () =>
		readFileSync(join(stateDir, "guard", "log.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.map((e) => `${e.event}${e.operation ? `:${e.operation.target}` : ""}`);
	return { intake, d, ran, events };
};

describe("取り消せない操作の許可（Claude CLI のモック + 本物の hook）", () => {
	it("dev/ への push は聞かずに通す", async () => {
		const { intake, d, ran } = await setup("git push -u origin HEAD:dev/x");
		await intake.handle(say("push して", { first: true }));
		expect(ran()).toEqual(["git push -u origin HEAD:dev/x"]);
		expect(d.sent.map((s) => s.content)).toEqual(["push しました"]);
		expect(d.tag()).toEqual(["tag-done"]);
	});

	it("止めた操作を投稿で聞き、OK の後に 1 回だけ通し、次の同じ操作はまた止める", async () => {
		const { intake, d, ran, events } = await setup("git push origin main");

		await intake.handle(say("main に push して", { first: true }));
		expect(ran()).toEqual([]);
		const request = d.sent.at(-1);
		expect(request?.content).toContain("決めてほしいこと");
		expect(request?.content).toContain("```\ngit push origin main\n```");
		// Claude が「完了」と書いても、止めた操作があれば持ち主の判断を待つ
		expect(d.tag()).toEqual(["tag-decide"]);

		await intake.handle(say("OK"));
		expect(ran()).toEqual(["git push origin main"]);
		expect(d.sent.at(-1)?.content).toBe("push しました");
		expect(d.tag()).toEqual(["tag-done"]);

		await intake.handle(say("もう一回 main に push して"));
		expect(ran()).toEqual(["git push origin main"]);
		expect(d.sent.at(-1)?.content).toContain("決めてほしいこと");
		expect(d.tag()).toEqual(["tag-decide"]);

		expect(events()).toEqual([
			"blocked:git push origin main",
			"requested",
			"granted",
			"used:git push origin main",
			"blocked:git push origin main",
			"requested",
		]);
	});

	it("決まった言い方以外の返事や、ほかのメッセージへの OK では通さない", async () => {
		const { intake, d, ran } = await setup("gh pr merge 3");
		await intake.handle(say("マージして", { first: true }));
		const first = d.sent.at(-1)?.id ?? "";

		await intake.handle(say("うーん、いいかも"));
		expect(ran()).toEqual([]);
		const second = d.sent.at(-1)?.id ?? "";
		expect(second).not.toBe(first);

		// 取りやめた前の依頼への OK は効かない
		await intake.handle(say("OK", { replyTo: first }));
		expect(ran()).toEqual([]);

		const third = d.sent.at(-1)?.id ?? "";
		await intake.handle(say("許可します。", { replyTo: third }));
		expect(ran()).toEqual(["gh pr merge 3"]);
	});
});
