import type { PendingOperation, PendingStore } from "@yunomi/capabilities";

type PendingRow = {
	id: string;
	partner_id: string;
	channel_id: string;
	tool: string;
	input_json: string;
	requested_by: string;
	source_message_id: string;
	created_at: string;
	expires_at: string;
	status: PendingOperation["status"];
	resolved_at: string | null;
};

const toOperation = (r: PendingRow): PendingOperation => ({
	id: r.id,
	partnerId: r.partner_id,
	channelId: r.channel_id,
	tool: r.tool,
	input: JSON.parse(r.input_json),
	requestedBy: r.requested_by,
	sourceMessageId: r.source_message_id,
	createdAt: r.created_at,
	expiresAt: r.expires_at,
	status: r.status,
	resolvedAt: r.resolved_at,
});

/** 保留中の操作を DO の SQLite に持つ。SQL は同期なので、save の複数行は 1 つの書き込みにまとまる。 */
export const createPendingStore = (sql: SqlStorage): PendingStore => ({
	async listOpen(partnerId, channelId) {
		return sql
			.exec<PendingRow>(
				`SELECT * FROM pending_operations
				WHERE partner_id = ? AND channel_id = ? AND status = 'proposed'
				ORDER BY created_at, rowid`,
				partnerId,
				channelId,
			)
			.toArray()
			.map(toOperation);
	},

	async get(partnerId, id) {
		const row = sql
			.exec<PendingRow>(
				"SELECT * FROM pending_operations WHERE partner_id = ? AND id = ?",
				partnerId,
				id,
			)
			.toArray()[0];
		return row ? toOperation(row) : null;
	},

	async save(ops) {
		for (const op of ops) {
			sql.exec(
				`INSERT INTO pending_operations
					(id, partner_id, channel_id, tool, input_json, requested_by, source_message_id,
					created_at, expires_at, status, resolved_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (id) DO UPDATE SET
					partner_id = excluded.partner_id,
					channel_id = excluded.channel_id,
					tool = excluded.tool,
					input_json = excluded.input_json,
					requested_by = excluded.requested_by,
					source_message_id = excluded.source_message_id,
					created_at = excluded.created_at,
					expires_at = excluded.expires_at,
					status = excluded.status,
					resolved_at = excluded.resolved_at`,
				op.id,
				op.partnerId,
				op.channelId,
				op.tool,
				JSON.stringify(op.input),
				op.requestedBy,
				op.sourceMessageId,
				op.createdAt,
				op.expiresAt,
				op.status,
				op.resolvedAt,
			);
		}
	},
});
