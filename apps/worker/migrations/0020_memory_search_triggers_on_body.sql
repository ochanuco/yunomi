-- 想起の記録（recall_count、last_recalled_at）や定着の回数だけの更新で索引の行を入れ直さないよう、
-- 索引の文書に効く列の更新に限って発火させる。
DROP TRIGGER `facts_search_au`;
--> statement-breakpoint
CREATE TRIGGER `facts_search_au` AFTER UPDATE OF partner_id, predicate, object_value, object_display, observed_at, valid_to, superseded_by ON `facts` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'fact' AND source_id = old.id;
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	SELECT 'fact', new.id, new.partner_id, new.predicate || ' ' || coalesce(new.object_display, new.object_value), new.observed_at
	WHERE new.valid_to IS NULL AND new.superseded_by IS NULL;
END;
--> statement-breakpoint
DROP TRIGGER `conversation_chunks_search_au`;
--> statement-breakpoint
CREATE TRIGGER `conversation_chunks_search_au` AFTER UPDATE OF partner_id, body, occurred_at ON `conversation_chunks` BEGIN
	DELETE FROM `memory_search_docs` WHERE kind = 'conversation' AND source_id = old.id;
	INSERT INTO `memory_search_docs` (kind, source_id, partner_id, body, at)
	VALUES ('conversation', new.id, new.partner_id, new.body, new.occurred_at);
END;
