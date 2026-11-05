import { newId } from "@yunomi/core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { workNotes } from "./db/schema.ts";

export const workNoteKinds = ["decided", "done"] as const;

export type WorkNoteKind = (typeof workNoteKinds)[number];

/** Talking の prompt に混ぜる件数。新しいものから採る。 */
export const WORK_NOTE_PROMPT_LIMIT = 10;
export const WORK_NOTE_SUMMARY_MAX_LENGTH = 200;

/** Talking の記憶の行で predicate の位置に置く語。 */
export const WORK_NOTE_PREDICATE = {
	decided: "仕事で決めたこと",
	done: "仕事で終えたこと",
} as const satisfies Record<WorkNoteKind, string>;

export type WorkNote = {
	id: string;
	kind: WorkNoteKind;
	summary: string;
	createdAt: Date;
};

export type WorkNoteRepo = {
	add(input: {
		partnerId: string;
		entityId: string;
		kind: WorkNoteKind;
		summary: string;
		now: Date;
	}): Promise<WorkNote>;
};

export const createWorkNoteRepo = (db: DrizzleD1Database): WorkNoteRepo => ({
	async add({ partnerId, entityId, kind, summary, now }) {
		const id = newId();
		await db.insert(workNotes).values({
			id,
			partnerId,
			entityId,
			kind,
			summary,
			createdAt: now.toISOString(),
		});
		return { id, kind, summary, createdAt: now };
	},
});
