import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const partners = sqliteTable("partners", {
	id: text("id").primaryKey(),
	createdAt: text("created_at").notNull(),
});
