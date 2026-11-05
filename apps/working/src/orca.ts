import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "@yunomi/core";
import * as v from "valibot";
import type { Exec } from "./exec.ts";
import type { Logger } from "./logger.ts";

export type OrcaError = { type: "OrcaFailed"; command: string; reason: string };

/** 席から受付に届くメッセージ。 */
export type SeatMessage = {
	id: string;
	type: string;
	subject: string;
	body: string;
	dispatchId: string | null;
	outcome: "succeeded" | "failed" | null;
	/** 席の Claude が worker_done を送らずにターンを終えたときの escalation に付く。 */
	stopReason: string | null;
};

/** 席の Claude の居場所。Orca は席を 1 つの Dispatch とその端末で表す。 */
export type SeatHandle = { dispatchId: string; terminal: string; path: string };

export type SeatResidue = {
	worktrees: string[];
	terminals: { handle: string; path: string }[];
};

/** 受付と席のやりとりに使う Orca の操作。受付はこの口だけで Orca に触る。 */
export type Orca = {
	/**
	 * 同じコンテナの orca serve が受け付けられるようになるまで待つ。
	 * serve は受付と同時に起動し、ready になる前の CLI は runtime_unavailable で即座に失敗する。
	 */
	waitReady: (timeoutMs: number) => Promise<Result<void, OrcaError>>;
	/** 受付の端末を作り直し、Run を引き継ぐ（無ければ作る）。 */
	prepare: (prev: {
		runId: string | null;
		reception: string | null;
	}) => Promise<Result<{ runId: string; reception: string }, OrcaError>>;
	/** 新しい worktree に席を作り、Claude に spec を渡す。 */
	startSeat: (input: {
		name: string;
		title: string;
		spec: string;
	}) => Promise<Result<SeatHandle, OrcaError>>;
	/** 止めた席の Claude を前の会話のまま起こし、spec を渡す。 */
	resumeSeat: (input: {
		path: string;
		title: string;
		spec: string;
	}) => Promise<Result<SeatHandle, OrcaError>>;
	/** 席に続きを渡す。作業中ならターンの終わりに、終わった席なら続きの Dispatch として届く。 */
	send: (input: {
		dispatchId: string;
		subject: string;
		body: string;
	}) => Promise<
		Result<{ dispatchId: string; terminal: string | null }, OrcaError>
	>;
	reply: (input: {
		messageId: string;
		body: string;
	}) => Promise<Result<void, OrcaError>>;
	/** 席の Claude を止める。worktree は残す。 */
	stopSeat: (seat: {
		dispatchId: string | null;
		terminal: string | null;
	}) => Promise<Result<void, OrcaError>>;
	removeWorktree: (path: string) => Promise<Result<void, OrcaError>>;
	closeTerminal: (handle: string) => Promise<Result<void, OrcaError>>;
	liveTerminals: () => Promise<Result<Set<string>, OrcaError>>;
	/** 席の置き場所にある worktree と、その中の端末。 */
	residue: () => Promise<Result<SeatResidue, OrcaError>>;
	/** 届いたメッセージを待って受け取る。届かないまま timeoutMs たてば空で返す。 */
	waitMessages: (
		timeoutMs: number,
	) => Promise<Result<SeatMessage[], OrcaError>>;
};

const envelope = v.object({
	ok: v.boolean(),
	result: v.optional(v.unknown()),
	error: v.optional(
		v.object({ code: v.optional(v.string()), message: v.optional(v.string()) }),
	),
});

const runSchema = v.object({ runId: v.string() });
const statusSchema = v.object({
	runtime: v.optional(v.object({ state: v.optional(v.string()) })),
});
const terminalSchema = v.object({
	terminal: v.object({ handle: v.string() }),
});
const startSchema = v.object({
	dispatchId: v.string(),
	terminal: v.string(),
	workspace: v.string(),
});
const sendSchema = v.object({
	dispatchId: v.optional(v.string()),
	terminal: v.optional(v.string()),
});
const reposSchema = v.object({
	repos: v.array(v.object({ id: v.string(), path: v.string() })),
});
const worktreesSchema = v.object({
	worktrees: v.array(v.object({ path: v.string() })),
});
const terminalsSchema = v.object({
	terminals: v.array(
		v.object({
			handle: v.string(),
			worktreePath: v.optional(v.string()),
			title: v.optional(v.nullish(v.string())),
		}),
	),
});
const messagesSchema = v.object({
	messages: v.optional(
		v.array(
			v.object({
				id: v.string(),
				type: v.string(),
				subject: v.optional(v.nullish(v.string())),
				body: v.optional(v.nullish(v.string())),
				payload: v.optional(
					v.nullish(
						v.object({
							dispatchId: v.optional(v.string()),
							outcome: v.optional(v.string()),
							stopReason: v.optional(v.string()),
						}),
					),
				),
			}),
		),
	),
});

/** worker-start の workspace は `<repoId>::<path>`。 */
const pathOfWorkspace = (workspace: string) =>
	workspace.includes("::")
		? workspace.slice(workspace.indexOf("::") + 2)
		: workspace;

const isUnder = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`);

const parseJson = (stdout: string): unknown => {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start === -1 || end < start) return null;
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
};

export type OrcaCliOptions = {
	bin: string;
	exec: Exec;
	env: Record<string, string>;
	/**
	 * orca-ide を動かす作業ディレクトリ。受付の起動時からあるディレクトリにする。
	 * 席の元のリポジトリは prepare で作るので、空の volume ではそれより前に cwd にできない。
	 */
	cwd: string;
	/** 席の worktree の元にする空の git リポジトリ。 */
	seatsRepo: string;
	/** Orca が席の worktree を作る場所（realpath）。 */
	seatsDir: string;
	/** spec を一時的に置く場所。 */
	specDir: string;
	logger: Logger;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

const RECEPTION_TITLE = "受付";
const START_TIMEOUT_MS = 180_000;

export const createOrcaCli = (opts: OrcaCliOptions): Orca => {
	const log = opts.logger;
	let reception: string | null = null;
	let runId: string | null = null;
	let repoId: string | null = null;

	const call = async <T>(
		args: readonly string[],
		schema: v.GenericSchema<unknown, T>,
		timeoutMs = opts.timeoutMs ?? 60_000,
	): Promise<Result<T, OrcaError>> => {
		const command = args.slice(0, 2).join(" ");
		const out = await opts.exec(opts.bin, [...args, "--json"], {
			stdin: "",
			cwd: opts.cwd,
			timeoutMs,
			env: opts.env,
		});
		const env = v.safeParse(envelope, parseJson(out.stdout));
		if (!env.success) {
			return err({
				type: "OrcaFailed",
				command,
				reason: (out.stderr || out.stdout).slice(0, 300) || `exit ${out.code}`,
			});
		}
		if (!env.output.ok) {
			const reason =
				env.output.error?.message ??
				(out.stderr.trim().split("\n").at(-1) || `exit ${out.code}`);
			return err({ type: "OrcaFailed", command, reason: reason.slice(0, 300) });
		}
		const parsed = v.safeParse(schema, env.output.result);
		if (!parsed.success) {
			return err({ type: "OrcaFailed", command, reason: "unexpected result" });
		}
		return ok(parsed.output);
	};

	const ignore = v.unknown();
	const asCoordinator = () => ["--from", reception ?? "", "--run", runId ?? ""];

	/** 席の元のリポジトリを Orca に登録する。リポジトリは start.sh が serve より先に作っておく。 */
	const ensureSeatsRepo = async (): Promise<Result<string, OrcaError>> => {
		const hasGit = await stat(join(opts.seatsRepo, ".git")).then(
			() => true,
			() => false,
		);
		if (!hasGit) {
			return err({
				type: "OrcaFailed",
				command: "repo list",
				reason: `${opts.seatsRepo} に git リポジトリが無い（start.sh の init-seats-repo.sh が作る）`,
			});
		}
		const repos = await call(["repo", "list"], reposSchema);
		if (!repos.ok) return repos;
		const found = repos.value.repos.find((r) => r.path === opts.seatsRepo);
		if (found) return ok(found.id);
		const added = await call(
			["repo", "add", "--path", opts.seatsRepo],
			v.object({ repo: v.object({ id: v.string() }) }),
		);
		return added.ok ? ok(added.value.repo.id) : added;
	};

	const writeSpec = async (spec: string) => {
		await mkdir(opts.specDir, { recursive: true });
		const path = join(
			opts.specDir,
			`${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
		);
		await writeFile(path, spec, { mode: 0o600 });
		return path;
	};

	const startWith = async (
		args: readonly string[],
		spec: string,
		title: string,
	): Promise<Result<SeatHandle, OrcaError>> => {
		const specFile = await writeSpec(spec);
		try {
			const r = await call(
				[
					"orchestration",
					"worker-start",
					...asCoordinator(),
					"--spec-file",
					specFile,
					"--task-title",
					title,
					"--timeout-ms",
					String(START_TIMEOUT_MS),
					...args,
				],
				startSchema,
				START_TIMEOUT_MS + 30_000,
			);
			if (!r.ok) return r;
			return ok({
				dispatchId: r.value.dispatchId,
				terminal: r.value.terminal,
				path: pathOfWorkspace(r.value.workspace),
			});
		} finally {
			await rm(specFile, { force: true });
		}
	};

	const terminals = () => call(["terminal", "list"], terminalsSchema);

	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	const createReception = () =>
		call(
			[
				"terminal",
				"create",
				"--worktree",
				`path:${opts.seatsRepo}`,
				"--title",
				RECEPTION_TITLE,
				"--command",
				"sleep infinity",
			],
			terminalSchema,
		);

	return {
		waitReady: async (timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			let last = "not checked";
			for (;;) {
				const r = await call(["status"], statusSchema, 10_000);
				if (r.ok && r.value.runtime?.state === "ready") return ok(undefined);
				const reason = r.ok
					? `state ${r.value.runtime?.state ?? "unknown"}`
					: r.error.reason;
				if (reason !== last) log.info("waiting for orca serve", { reason });
				last = reason;
				if (Date.now() >= deadline) {
					return err({ type: "OrcaFailed", command: "status", reason: last });
				}
				await sleep(1_000);
			}
		},
		prepare: async (prev) => {
			const repo = await ensureSeatsRepo();
			if (!repo.ok) return repo;
			repoId = repo.value;
			// 前の受付の端末が残っていると Run を引き継げない
			if (prev.reception) {
				await call(["terminal", "close", "--terminal", prev.reception], ignore);
			}
			const listed = await terminals();
			if (listed.ok) {
				for (const t of listed.value.terminals) {
					if (
						t.title === RECEPTION_TITLE &&
						t.worktreePath === opts.seatsRepo
					) {
						await call(["terminal", "close", "--terminal", t.handle], ignore);
					}
				}
			}
			const created = await createReception();
			if (!created.ok) return created;
			reception = created.value.terminal.handle;
			if (prev.runId) {
				const used = await call(
					["orchestration", "run-use", "--id", prev.runId, "--from", reception],
					runSchema,
				);
				if (used.ok) {
					runId = used.value.runId;
					return ok({ runId, reception });
				}
				log.warn("orca run-use failed; creating a new run", {
					reason: used.error.reason,
				});
			}
			const run = await call(
				[
					"orchestration",
					"run-create",
					"--objective",
					"仕事フォーラムの投稿ごとの席",
					"--from",
					reception,
				],
				runSchema,
			);
			if (!run.ok) return run;
			runId = run.value.runId;
			return ok({ runId, reception });
		},
		startSeat: async ({ name, title, spec }) => {
			// 前に閉じそこねた同じ名前の worktree があると作れない
			const stale = join(opts.seatsDir, name);
			if (
				await stat(stale).then(
					() => true,
					() => false,
				)
			) {
				await call(
					[
						"worktree",
						"rm",
						"--worktree",
						`path:${stale}`,
						"--force",
						"--delete-branch",
					],
					ignore,
				);
			}
			return startWith(
				[
					"--worktree",
					"new-top-level",
					"--repo",
					`id:${repoId ?? ""}`,
					"--name",
					name,
					"--agent",
					"claude",
				],
				spec,
				title,
			);
		},
		resumeSeat: async ({ path, title, spec }) => {
			// Orca が Claude を新しく起動すると会話が残らないので、--continue で起こした端末に渡す
			const created = await call(
				[
					"terminal",
					"create",
					"--worktree",
					`path:${path}`,
					"--title",
					title,
					"--command",
					"claude --continue",
				],
				terminalSchema,
			);
			if (!created.ok) return created;
			return startWith(
				[
					"--terminal",
					created.value.terminal.handle,
					"--worktree",
					`path:${path}`,
				],
				spec,
				title,
			);
		},
		send: async ({ dispatchId, subject, body }) => {
			const r = await call(
				[
					"orchestration",
					"send",
					...asCoordinator(),
					"--to",
					`dispatch:${dispatchId}`,
					"--subject",
					subject,
					"--body",
					body,
				],
				sendSchema,
				START_TIMEOUT_MS + 30_000,
			);
			if (!r.ok) return r;
			return ok({
				dispatchId: r.value.dispatchId ?? dispatchId,
				terminal: r.value.terminal ?? null,
			});
		},
		reply: async ({ messageId, body }) => {
			const r = await call(
				[
					"orchestration",
					"reply",
					...asCoordinator(),
					"--id",
					messageId,
					"--body",
					body,
				],
				ignore,
			);
			return r.ok ? ok(undefined) : r;
		},
		stopSeat: async ({ dispatchId, terminal }) => {
			// 席の端末は Orca が起動したものと受付が --continue で作ったものがあり、止め方が違う。
			// どれが効いたかは問わず、最後に端末が消えたかだけを見る。
			if (dispatchId) {
				await call(
					["orchestration", "worker-stop", "--dispatch", dispatchId],
					ignore,
				);
				await call(
					["orchestration", "worker-release", "--dispatch", dispatchId],
					ignore,
				);
			}
			if (terminal) {
				await call(["terminal", "close", "--terminal", terminal], ignore);
			}
			if (dispatchId) {
				await call(
					["orchestration", "worker-abandon", "--dispatch", dispatchId],
					ignore,
				);
			}
			if (!terminal) return ok(undefined);
			const live = await terminals();
			if (!live.ok) return live;
			return live.value.terminals.some((t) => t.handle === terminal)
				? err({
						type: "OrcaFailed",
						command: "terminal close",
						reason: "still running",
					})
				: ok(undefined);
		},
		removeWorktree: async (path) => {
			const r = await call(
				[
					"worktree",
					"rm",
					"--worktree",
					`path:${path}`,
					"--force",
					"--delete-branch",
				],
				ignore,
			);
			return r.ok ? ok(undefined) : r;
		},
		closeTerminal: async (handle) => {
			const r = await call(["terminal", "close", "--terminal", handle], ignore);
			return r.ok ? ok(undefined) : r;
		},
		liveTerminals: async () => {
			const r = await terminals();
			return r.ok ? ok(new Set(r.value.terminals.map((t) => t.handle))) : r;
		},
		residue: async () => {
			const [wts, terms] = await Promise.all([
				call(["worktree", "list"], worktreesSchema),
				terminals(),
			]);
			if (!wts.ok) return wts;
			if (!terms.ok) return terms;
			return ok({
				worktrees: wts.value.worktrees
					.map((w) => w.path)
					.filter((p) => p !== opts.seatsDir && isUnder(p, opts.seatsDir)),
				terminals: terms.value.terminals.flatMap((t) =>
					t.worktreePath && isUnder(t.worktreePath, opts.seatsDir)
						? [{ handle: t.handle, path: t.worktreePath }]
						: [],
				),
			});
		},
		waitMessages: async (timeoutMs) => {
			const r = await call(
				[
					"orchestration",
					"check",
					"--terminal",
					reception ?? "",
					"--run",
					runId ?? "",
					"--wait",
					"--timeout-ms",
					String(timeoutMs),
				],
				messagesSchema,
				timeoutMs + 30_000,
			);
			if (!r.ok) return r;
			return ok(
				(r.value.messages ?? []).map((m) => ({
					id: m.id,
					type: m.type,
					subject: m.subject ?? "",
					body: m.body ?? "",
					dispatchId: m.payload?.dispatchId ?? null,
					outcome:
						m.payload?.outcome === "succeeded" ||
						m.payload?.outcome === "failed"
							? m.payload.outcome
							: null,
					stopReason: m.payload?.stopReason ?? null,
				})),
			);
		},
	};
};
