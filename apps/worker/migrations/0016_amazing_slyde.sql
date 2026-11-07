CREATE TABLE `conversation_chunk_messages` (
	`chunk_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`chunk_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `conversation_chunk_messages_message` ON `conversation_chunk_messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `conversation_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`body` text NOT NULL,
	`started_at` text NOT NULL,
	`occurred_at` text NOT NULL,
	`ended_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_chunks_channel_time` ON `conversation_chunks` (`partner_id`,`channel_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `memory_search_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`partner_id` text NOT NULL,
	`body` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_search_docs_source` ON `memory_search_docs` (`kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `memory_search_docs_partner` ON `memory_search_docs` (`partner_id`,`id`);