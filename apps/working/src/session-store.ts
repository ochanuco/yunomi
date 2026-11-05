import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

const fileSchema = v.object({
	threads: v.record(
		v.string(),
		v.object({ session_id: v.string(), fork: v.optional(v.boolean()) }),
	),
});

export type SessionStore = {
	get: (threadId: string) => string | null;
	/** 朝会のセッションから分かれる投稿。最初の返事のときに fork し、以後は fork 先を resume する。 */
	isFork: (threadId: string) => boolean;
	set: (threadId: string, sessionId: string, fork?: boolean) => Promise<void>;
};

/**
 * フォーラム投稿とセッションの対応。受付を作り直しても続きができるよう volume 上の JSON に置く。
 * 件数は投稿の数だけなので、全体を読み書きする。
 */
export const openSessionStore = async (dir: string): Promise<SessionStore> => {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "threads.json");
	const threads = new Map<string, { sessionId: string; fork: boolean }>();
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw !== null) {
		const parsed = v.safeParse(
			fileSchema,
			(() => {
				try {
					return JSON.parse(raw);
				} catch {
					return null;
				}
			})(),
		);
		if (!parsed.success) {
			throw new Error(`${path} を読めない`);
		}
		for (const [id, t] of Object.entries(parsed.output.threads)) {
			threads.set(id, { sessionId: t.session_id, fork: t.fork ?? false });
		}
	}

	let writing: Promise<void> = Promise.resolve();
	const flush = () => {
		const body = {
			threads: Object.fromEntries(
				[...threads].map(([id, t]) => [
					id,
					t.fork
						? { session_id: t.sessionId, fork: true }
						: { session_id: t.sessionId },
				]),
			),
		};
		// 書きかけで落ちても前の内容が残るよう、別名に書いてから置き換える
		writing = writing.then(async () => {
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify(body, null, "\t"));
			await rename(tmp, path);
		});
		return writing;
	};

	return {
		get: (threadId) => threads.get(threadId)?.sessionId ?? null,
		isFork: (threadId) => threads.get(threadId)?.fork ?? false,
		set: (threadId, sessionId, fork = false) => {
			threads.set(threadId, { sessionId, fork });
			return flush();
		},
	};
};
