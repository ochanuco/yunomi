-- キーワード検索の索引。日本語は語の区切りが無いため trigram で引く。
-- memory_search_docs を external content にし、本文を二重に持たない。
CREATE VIRTUAL TABLE `memory_search_fts` USING fts5(
	body,
	content = 'memory_search_docs',
	content_rowid = 'id',
	tokenize = 'trigram'
);
--> statement-breakpoint
CREATE TRIGGER `memory_search_docs_ai` AFTER INSERT ON `memory_search_docs` BEGIN
	INSERT INTO `memory_search_fts` (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_search_docs_ad` AFTER DELETE ON `memory_search_docs` BEGIN
	INSERT INTO `memory_search_fts` (`memory_search_fts`, rowid, body) VALUES ('delete', old.id, old.body);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_search_docs_au` AFTER UPDATE ON `memory_search_docs` BEGIN
	INSERT INTO `memory_search_fts` (`memory_search_fts`, rowid, body) VALUES ('delete', old.id, old.body);
	INSERT INTO `memory_search_fts` (rowid, body) VALUES (new.id, new.body);
END;
--> statement-breakpoint
-- 索引に入れる facts は現行のものだけ。置き換え（superseded_by）や期限（valid_to）が付いたら外す。
-- 書き込みの経路によらず追従させるため、アプリではなく trigger で保つ。
CREATE TRIGGER `facts_search_ai` AFTER INSERT ON `facts`
WHEN new.valid_to IS NULL AND new.superseded_by IS NULL BEGIN
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('fact', new.id, new.partner_id, new.predicate || ' ' || coalesce(new.object_display, new.object_value), new.observed_at);
END;
--> statement-breakpoint
CREATE TRIGGER `facts_search_au` AFTER UPDATE ON `facts` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'fact' AND source_id = old.id;
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	SELECT 'fact', new.id, new.partner_id, new.predicate || ' ' || coalesce(new.object_display, new.object_value), new.observed_at
	WHERE new.valid_to IS NULL AND new.superseded_by IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `facts_search_ad` AFTER DELETE ON `facts` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'fact' AND source_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `work_notes_search_ai` AFTER INSERT ON `work_notes` BEGIN
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('work_note', new.id, new.partner_id, new.summary, new.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `work_notes_search_au` AFTER UPDATE OF partner_id, summary, created_at ON `work_notes` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'work_note' AND source_id = old.id;
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('work_note', new.id, new.partner_id, new.summary, new.created_at);
END;
--> statement-breakpoint
CREATE TRIGGER `work_notes_search_ad` AFTER DELETE ON `work_notes` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'work_note' AND source_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_chunks_search_ai` AFTER INSERT ON `conversation_chunks` BEGIN
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('conversation', new.id, new.partner_id, new.body, new.occurred_at);
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_chunks_search_au` AFTER UPDATE ON `conversation_chunks` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'conversation' AND source_id = old.id;
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('conversation', new.id, new.partner_id, new.body, new.occurred_at);
END;
--> statement-breakpoint
CREATE TRIGGER `conversation_chunks_search_ad` AFTER DELETE ON `conversation_chunks` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'conversation' AND source_id = old.id;
END;
--> statement-breakpoint
INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
SELECT 'fact', id, partner_id, predicate || ' ' || coalesce(object_display, object_value), observed_at
FROM `facts` WHERE valid_to IS NULL AND superseded_by IS NULL;
--> statement-breakpoint
INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
SELECT 'work_note', id, partner_id, summary, created_at FROM `work_notes`;
