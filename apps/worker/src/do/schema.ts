// 各要素は 1 つのスキーマ version に対応する。適用済みの要素は書き換えず、末尾に足す。
const MIGRATIONS: string[][] = [
	[
		`CREATE TABLE IF NOT EXISTS recent_messages (
			channel_id TEXT NOT NULL,
			message_id TEXT PRIMARY KEY,
			author_id TEXT NOT NULL,
			author_name TEXT NOT NULL,
			is_bot INTEGER NOT NULL,
			is_partner INTEGER NOT NULL,
			content TEXT NOT NULL,
			occurred_at TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS recent_messages_channel ON recent_messages (channel_id)",
		`CREATE TABLE IF NOT EXISTS processed_events (
			dedupe_key TEXT PRIMARY KEY,
			processed_at TEXT NOT NULL,
			response_json TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS channel_state (
			channel_id TEXT PRIMARY KEY,
			last_partner_reply_at TEXT
		)`,
	],
];

export const migrateDoStorage = (sql: SqlStorage): void => {
	sql.exec(
		"CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
	);
	sql.exec("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)");
	const row = sql
		.exec<{ version: number }>(
			"SELECT version FROM schema_version WHERE id = 1",
		)
		.one();
	for (let v = row.version; v < MIGRATIONS.length; v++) {
		for (const statement of MIGRATIONS[v] ?? []) sql.exec(statement);
		sql.exec("UPDATE schema_version SET version = ? WHERE id = 1", v + 1);
	}
};
