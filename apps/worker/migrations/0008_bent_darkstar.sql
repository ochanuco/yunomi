CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`partner_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`discord_message_id` text,
	`turn_event_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`is_bot` integer NOT NULL,
	`is_partner` integer NOT NULL,
	`content` text NOT NULL,
	`occurred_at` text NOT NULL,
	`logged_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_key` ON `conversation_messages` (`partner_id`,`channel_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `conversation_messages_channel_time` ON `conversation_messages` (`partner_id`,`channel_id`,`occurred_at`);