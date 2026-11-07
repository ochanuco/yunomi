ALTER TABLE `conversation_chunks` ADD `recall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversation_chunks` ADD `last_recalled_at` text;--> statement-breakpoint
ALTER TABLE `facts` ADD `recall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `facts` ADD `last_recalled_at` text;--> statement-breakpoint
ALTER TABLE `work_notes` ADD `recall_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `work_notes` ADD `last_recalled_at` text;