import type { AuditItem } from "@yunomi/admin-contract";
import { type Command, type Global, HELP, parseCli } from "./args.ts";
import { ApiError, createClient, type Fetch } from "./client.ts";
import { ConfigError, resolveTarget } from "./config.ts";
import {
	auditHeader,
	formatAuditRow,
	formatCandidates,
	formatFacts,
	formatInterests,
	formatKpis,
	formatOpenLoops,
	formatOpinions,
	formatStatus,
} from "./format.ts";

export const FOLLOW_INTERVAL_MS = 5000;
const MAX_PAGE = 200;

export type Deps = {
	fetch: Fetch;
	env: Record<string, string | undefined>;
	out: (text: string) => void;
	err: (text: string) => void;
	now: () => Date;
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	signal: AbortSignal;
};

const oldestFirst = (items: AuditItem[]) => [...items].reverse();

export const run = async (argv: string[], deps: Deps): Promise<number> => {
	const parsed = parseCli(argv);
	if (!parsed.ok) {
		deps.err(`ykm: ${parsed.message}\n\n${HELP}`);
		return 2;
	}
	const { command, global } = parsed;
	if (command.name === "help") {
		deps.out(HELP);
		return 0;
	}
	try {
		const target = resolveTarget(global, deps.env);
		await execute(command, global, deps, target);
		return 0;
	} catch (e) {
		if (e instanceof ConfigError || e instanceof ApiError) {
			deps.err(`ykm: ${e.message}`);
			return 1;
		}
		throw e;
	}
};

const execute = async (
	command: Exclude<Command, { name: "help" }>,
	global: Global,
	deps: Deps,
	target: ReturnType<typeof resolveTarget>,
): Promise<void> => {
	const client = createClient(target, global.partner, deps.fetch);
	const json = (value: unknown) => deps.out(JSON.stringify(value, null, 2));

	switch (command.name) {
		case "status": {
			const [status, rels] = await Promise.all([
				client.status(),
				client.relationships(),
			]);
			if (global.json) json({ status, relationships: rels.items });
			else deps.out(formatStatus(status, rels.items));
			return;
		}
		case "memory-list": {
			const kind = command.candidates ? "candidates" : "facts";
			const page = await client.memory({
				kind,
				limit: command.limit,
				include: command.all ? "all" : undefined,
			});
			if (global.json) json(page);
			else if (page.kind === "facts") {
				deps.out(formatFacts(page.items, deps.now()));
			} else deps.out(formatCandidates(page.items));
			if (!global.json && page.next_cursor) {
				deps.err(`(続きあり: --limit を増やすと ${MAX_PAGE} 件まで見られる)`);
			}
			return;
		}
		case "open-loops": {
			const page = await client.openLoops({
				status: command.all ? "all" : undefined,
				limit: command.limit,
			});
			deps.out(
				global.json
					? JSON.stringify(page, null, 2)
					: formatOpenLoops(page.items),
			);
			if (!global.json && page.next_cursor) {
				deps.err(`(続きあり: --limit を増やすと ${MAX_PAGE} 件まで見られる)`);
			}
			return;
		}
		case "interests": {
			const r = await client.interests();
			deps.out(
				global.json ? JSON.stringify(r, null, 2) : formatInterests(r.items),
			);
			return;
		}
		case "opinions": {
			const r = await client.opinions();
			deps.out(
				global.json ? JSON.stringify(r, null, 2) : formatOpinions(r.items),
			);
			return;
		}
		case "kpi": {
			const r = await client.kpis({ days: command.days });
			deps.out(global.json ? JSON.stringify(r, null, 2) : formatKpis(r.items));
			return;
		}
		case "audit-tail":
			await auditTail(command, global, deps, client);
			return;
	}
};

const auditTail = async (
	command: Extract<Command, { name: "audit-tail" }>,
	global: Global,
	deps: Deps,
	client: ReturnType<typeof createClient>,
): Promise<void> => {
	const started = deps.now().toISOString();
	const first = await client.audit({ limit: command.count });
	const items = oldestFirst(first.items);

	if (global.json) {
		for (const a of items) deps.out(JSON.stringify(a));
	} else {
		deps.out(auditHeader());
		for (const a of items) deps.out(formatAuditRow(a));
	}
	if (!command.follow) return;

	// since は gte なので、境界の時刻に属する既出の行を id で除く。
	let since = items.at(-1)?.created_at ?? started;
	const seen = new Set(
		items.filter((a) => a.created_at === since).map((a) => a.id),
	);
	while (!deps.signal.aborted) {
		await deps.sleep(FOLLOW_INTERVAL_MS, deps.signal);
		if (deps.signal.aborted) break;
		const page = await client.audit({ limit: MAX_PAGE, since });
		const fresh = oldestFirst(page.items).filter((a) => !seen.has(a.id));
		for (const a of fresh) {
			deps.out(global.json ? JSON.stringify(a) : formatAuditRow(a));
			if (a.created_at !== since) {
				since = a.created_at;
				seen.clear();
			}
			seen.add(a.id);
		}
	}
};
