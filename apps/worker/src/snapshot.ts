import type {
	Snapshot,
	SnapshotRestoreCounts,
	SnapshotSummary,
} from "@yunomi/admin-contract";
import { SNAPSHOT_SCHEMA_VERSION } from "@yunomi/admin-contract";
import { err, newId, ok, type PartnerState, type Result } from "@yunomi/core";
import type { PartnerDO } from "./do/partner-do.ts";
import { encryptSnapshot, parseSnapshot } from "./snapshot-codec.ts";
import { putSnapshot } from "./snapshot-store.ts";

type D1Table = {
	columns: string[];
	/** partner_id で絞れるテーブル。false は全 partner 共通（entities など）。 */
	scoped: boolean;
	/** upsert の衝突キー。scoped でないテーブルだけ使う。 */
	key: string[];
};

/**
 * Snapshot に含める D1 テーブルと列（partner_id を除く）。
 * 列は db/schema.ts と一致させる。ずれたらテストが落ちる。
 */
export const D1_SNAPSHOT_TABLES = {
	entities: {
		columns: ["id", "kind", "display_name", "created_at"],
		scoped: false,
		key: ["id"],
	},
	external_identities: {
		columns: ["provider", "external_id", "entity_id"],
		scoped: false,
		key: ["provider", "external_id"],
	},
	facts: {
		columns: [
			"id",
			"subject_entity_id",
			"predicate",
			"object_type",
			"object_value",
			"object_display",
			"confidence",
			"importance",
			"source",
			"observed_at",
			"valid_from",
			"valid_to",
			"decay_policy",
			"superseded_by",
		],
		scoped: true,
		key: [],
	},
	memory_candidates: {
		columns: [
			"id",
			"subject_entity_id",
			"subject_text",
			"predicate",
			"object_type",
			"object_value",
			"confidence",
			"importance",
			"source",
			"status",
			"conflict_fact_id",
			"expires_at",
			"created_at",
			"source_event_id",
		],
		scoped: true,
		key: [],
	},
	open_loops: {
		columns: [
			"id",
			"entity_id",
			"channel_id",
			"summary",
			"importance",
			"due_at",
			"due_confidence",
			"follow_up_interval_hours",
			"status",
			"source_message_id",
			"created_at",
			"updated_at",
			"resolved_at",
			"last_followed_up_at",
		],
		scoped: true,
		key: [],
	},
	interest_states: {
		columns: [
			"topic",
			"score",
			"baseline",
			"learned_delta",
			"summary",
			"updated_at",
			"source",
		],
		scoped: true,
		key: [],
	},
	opinion_states: {
		columns: [
			"topic",
			"stance",
			"confidence",
			"stability",
			"reasons",
			"source_memory_ids",
			"updated_at",
		],
		scoped: true,
		key: [],
	},
} satisfies Record<string, D1Table>;

type TableName = keyof typeof D1_SNAPSHOT_TABLES;
type Row = Record<string, unknown>;

const TABLE_NAMES = Object.keys(D1_SNAPSHOT_TABLES) as TableName[];
/** restore で partner の行を消してから入れ直すテーブル（子から先に消す）。 */
const SCOPED_TABLES = TABLE_NAMES.filter((t) => D1_SNAPSHOT_TABLES[t].scoped);

const readTable = async (
	db: D1Database,
	table: TableName,
	partnerId: string,
): Promise<Row[]> => {
	const def = D1_SNAPSHOT_TABLES[table];
	const cols = def.columns.join(", ");
	const stmt = def.scoped
		? db
				.prepare(
					`SELECT ${cols} FROM ${table} WHERE partner_id = ? ORDER BY rowid`,
				)
				.bind(partnerId)
		: db.prepare(`SELECT ${cols} FROM ${table} ORDER BY rowid`);
	return (await stmt.all<Row>()).results;
};

export type SnapshotError = {
	type: "snapshot_invalid" | "restore_failed";
	message: string;
};

const toStateView = (s: PartnerState) => ({
	mood: s.mood,
	energy: s.energy,
	presence: s.presence,
	system_stress: s.systemStress,
	degraded_mode: s.degradedMode,
	version: s.version,
	updated_at: s.updatedAt,
});

export type SnapshotContext = {
	db: D1Database;
	partner: DurableObjectStub<PartnerDO>;
	partnerId: string;
	env: string;
	now: Date;
};

/** 含める・含めないものの境界はここだけで決まる。出力は SnapshotSchema で検証する。 */
export const buildSnapshot = async (
	ctx: SnapshotContext,
): Promise<Result<Snapshot, SnapshotError>> => {
	const [tables, doState] = await Promise.all([
		Promise.all(
			TABLE_NAMES.map(
				async (t) => [t, await readTable(ctx.db, t, ctx.partnerId)] as const,
			),
		),
		ctx.partner.snapshotDoState(),
	]);
	const d1 = Object.fromEntries(tables);
	const candidate = {
		schema_version: SNAPSHOT_SCHEMA_VERSION,
		snapshot_id: newId(),
		partner_id: ctx.partnerId,
		env: ctx.env,
		created_at: ctx.now.toISOString(),
		d1,
		do: {
			state: doState.state && toStateView(doState.state),
			relationships: doState.relationships,
		},
	};
	const parsed = parseSnapshot(candidate);
	return parsed.ok
		? ok(parsed.value)
		: err({ type: "snapshot_invalid", message: parsed.message });
};

export type CreateSnapshotContext = SnapshotContext & {
	bucket: R2Bucket;
	recipient: string;
};

export const createSnapshot = async (
	ctx: CreateSnapshotContext,
): Promise<Result<SnapshotSummary, SnapshotError>> => {
	const built = await buildSnapshot(ctx);
	if (!built.ok) return built;
	const bytes = await encryptSnapshot(built.value, ctx.recipient);
	return ok(
		await putSnapshot(ctx.bucket, {
			id: built.value.snapshot_id,
			partnerId: ctx.partnerId,
			createdAt: built.value.created_at,
			env: ctx.env,
			bytes,
		}),
	);
};

const insertStatement = (
	db: D1Database,
	table: TableName,
	row: Row,
	partnerId: string,
) => {
	const def = D1_SNAPSHOT_TABLES[table];
	const columns: string[] = def.scoped
		? ["partner_id", ...def.columns]
		: [...def.columns];
	const values = def.scoped
		? [partnerId, ...def.columns.map((c) => row[c])]
		: def.columns.map((c) => row[c]);
	const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
	const key: string[] = def.key;
	const updates = def.columns.filter((c) => !key.includes(c));
	// entities は他の履歴テーブルから参照されるため、消さずに upsert する。
	const sql = def.scoped
		? insert
		: `${insert} ON CONFLICT (${def.key.join(", ")}) DO UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}`;
	return db.prepare(sql).bind(...values);
};

export type RestoreContext = {
	db: D1Database;
	partner: DurableObjectStub<PartnerDO>;
	partnerId: string;
};

/**
 * 対象 partner の長期記憶と DO の現在値を Snapshot で置き換える。
 * D1 は 1 回の batch（atomic）、DO は transaction。両者をまたぐ atomic は無いため、
 * 先に D1 を書き、DO が失敗したら再実行で揃える。audit・KPI・履歴は触らない。
 */
export const restoreSnapshot = async (
	ctx: RestoreContext,
	snapshot: Snapshot,
): Promise<Result<SnapshotRestoreCounts, SnapshotError>> => {
	if (snapshot.partner_id !== ctx.partnerId) {
		return err({
			type: "restore_failed",
			message: "snapshot の partner_id が対象と一致しない",
		});
	}
	const rows = snapshot.d1 as Record<TableName, Row[]>;
	const statements = [
		...[...SCOPED_TABLES]
			.reverse()
			.map((t) =>
				ctx.db
					.prepare(`DELETE FROM ${t} WHERE partner_id = ?`)
					.bind(ctx.partnerId),
			),
		...TABLE_NAMES.flatMap((t) =>
			rows[t].map((row) => insertStatement(ctx.db, t, row, ctx.partnerId)),
		),
	];
	try {
		await ctx.db.batch(statements);
		const state = snapshot.do.state;
		await ctx.partner.restoreDoState(
			state && {
				mood: state.mood,
				energy: state.energy,
				presence: state.presence as PartnerState["presence"],
				systemStress: state.system_stress,
				degradedMode: state.degraded_mode,
				version: state.version,
				updatedAt: state.updated_at,
			},
			snapshot.do.relationships,
		);
	} catch (e) {
		return err({
			type: "restore_failed",
			message: e instanceof Error ? e.message : String(e),
		});
	}
	return ok({
		entities: snapshot.d1.entities.length,
		external_identities: snapshot.d1.external_identities.length,
		facts: snapshot.d1.facts.length,
		memory_candidates: snapshot.d1.memory_candidates.length,
		open_loops: snapshot.d1.open_loops.length,
		interest_states: snapshot.d1.interest_states.length,
		opinion_states: snapshot.d1.opinion_states.length,
		relationships: snapshot.do.relationships.length,
	});
};
