CREATE TABLE `audit_daily_kpis` (
	`partner_id` text NOT NULL,
	`day` text NOT NULL,
	`turns` integer NOT NULL,
	`replies` integer NOT NULL,
	`ignores` integer NOT NULL,
	`errors` integer NOT NULL,
	`degraded` integer NOT NULL,
	`fallback_used` integer NOT NULL,
	`latency_p50_ms` integer,
	`latency_p95_ms` integer,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`partner_id`, `day`)
);
