import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** リポジトリに同梱した表情画像。`<dir>/<emotion>/*.png` の形で置く。 */
export const DEFAULT_AVATAR_DIR = fileURLToPath(
	new URL("../avatars/", import.meta.url),
);

export type AvatarImage = { name: string; path: string };

export type AvatarStock = {
	pick: (emotion: string) => AvatarImage | null;
	count: () => number;
};

export const createAvatarStock = (
	byEmotion: ReadonlyMap<string, readonly AvatarImage[]>,
	random: () => number = Math.random,
): AvatarStock => ({
	pick: (emotion) => {
		const images = byEmotion.get(emotion);
		if (!images || images.length === 0) return null;
		return images[Math.floor(random() * images.length)] ?? null;
	},
	count: () => [...byEmotion.values()].reduce((n, l) => n + l.length, 0),
});

/** 起動時に一度だけ一覧を作る。画像の中身は送るときにディスクから読む。 */
export const loadAvatarStock = async (
	dir: string,
	random?: () => number,
): Promise<AvatarStock> => {
	const byEmotion = new Map<string, AvatarImage[]>();
	let entries: { name: string; isDirectory: () => boolean }[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return createAvatarStock(byEmotion, random);
	}
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const files = await readdir(join(dir, e.name));
		const images = files
			.filter((f) => f.toLowerCase().endsWith(".png"))
			.sort()
			.map((f) => ({ name: f, path: join(dir, e.name, f) }));
		if (images.length > 0) byEmotion.set(e.name, images);
	}
	return createAvatarStock(byEmotion, random);
};
