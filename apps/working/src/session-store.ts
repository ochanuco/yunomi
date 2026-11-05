import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

const fileSchema = v.object({
	threads: v.record(v.string(), v.object({ session_id: v.string() })),
});

export type SessionStore = {
	get: (threadId: string) => string | null;
	set: (threadId: string, sessionId: string) => Promise<void>;
};

/**
 * フォーラム投稿とセッションの対応。受付を作り直しても続きができるよう volume 上の JSON に置く。
 * 件数は投稿の数だけなので、全体を読み書きする。
 */
export const openSessionStore = async (dir: string): Promise<SessionStore> => {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "threads.json");
	const threads = new Map<string, string>();
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
			threads.set(id, t.session_id);
		}
	}

	let writing: Promise<void> = Promise.resolve();
	const flush = () => {
		const body = {
			threads: Object.fromEntries(
				[...threads].map(([id, sessionId]) => [id, { session_id: sessionId }]),
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
		get: (threadId) => threads.get(threadId) ?? null,
		set: (threadId, sessionId) => {
			threads.set(threadId, sessionId);
			return flush();
		},
	};
};
