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
	[
		`CREATE TABLE IF NOT EXISTS partner_state (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			mood REAL NOT NULL,
			energy REAL NOT NULL,
			presence TEXT NOT NULL,
			system_stress REAL NOT NULL,
			degraded_mode INTEGER NOT NULL,
			version INTEGER NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS relationships (
			entity_id TEXT PRIMARY KEY,
			familiarity REAL NOT NULL,
			trust REAL NOT NULL,
			summary TEXT,
			version INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			acc_day TEXT NOT NULL,
			acc_familiarity REAL NOT NULL,
			acc_trust REAL NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS entity_cache (
			provider TEXT NOT NULL,
			external_id TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			PRIMARY KEY (provider, external_id)
		)`,
	],
	[
		// 既存行は NULL のまま。partner 発言だけが Gateway の sent 通知で埋まる
		"ALTER TABLE recent_messages ADD COLUMN discord_message_id TEXT",
		"CREATE INDEX IF NOT EXISTS recent_messages_discord_id ON recent_messages (discord_message_id)",
	],
	[
		`CREATE TABLE IF NOT EXISTS llm_health (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			failure_streak INTEGER NOT NULL
		)`,
	],
	[
		// 枠の外から割り込んで返事した最後の時刻。既存行は NULL（まだ割り込んでいない）
		"ALTER TABLE channel_state ADD COLUMN last_interjection_at TEXT",
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
