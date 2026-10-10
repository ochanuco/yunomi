CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`event_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`author_entity_id` text,
	`kind` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`decision_summary` text,
	`model` text,
	`fallback_used` integer NOT NULL,
	`degraded` integer NOT NULL,
	`error_type` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`latency_ms` integer NOT NULL,
	`inbound_content` text NOT NULL,
	`detail_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_events_partner_created` ON `audit_events` (`partner_id`,`created_at`);