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
	[
		// Gateway が実際に接続・切断したと報告した VC。同時に入れるのは 1 つだけ
		`CREATE TABLE IF NOT EXISTS voice_connection (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			voice_guild_id TEXT NOT NULL,
			voice_channel_id TEXT,
			voice_updated_at TEXT NOT NULL
		)`,
	],
	[
		// オーナーの了承を待つ道具の操作。解決した行も残し、同じ保留への二度目の了承を実行せずに状態遷移の拒否で返せるようにする
		`CREATE TABLE IF NOT EXISTS pending_operations (
			id TEXT PRIMARY KEY,
			partner_id TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			tool TEXT NOT NULL,
			input_json TEXT NOT NULL,
			requested_by TEXT NOT NULL,
			source_message_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			status TEXT NOT NULL,
			resolved_at TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS pending_operations_open ON pending_operations (partner_id, channel_id, status)",
	],
	[
		// 既存行は 0（耳を開けていない）。耳の報告は接続の報告と一緒に来る
		"ALTER TABLE voice_connection ADD COLUMN voice_listening INTEGER NOT NULL DEFAULT 0",
	],
	[
		// 既存行は書かれた発言として扱う
		"ALTER TABLE recent_messages ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'",
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
