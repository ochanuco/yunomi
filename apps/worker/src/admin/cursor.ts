export type Cursor = { at: string; id: string };

const SEPARATOR = "|";

export const encodeCursor = (c: Cursor): string =>
	btoa(`${c.at}${SEPARATOR}${c.id}`)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");

export const decodeCursor = (raw: string): Cursor | null => {
	try {
		const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
		const text = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
		const i = text.indexOf(SEPARATOR);
		if (i <= 0 || i === text.length - 1) return null;
		const at = text.slice(0, i);
		if (Number.isNaN(Date.parse(at))) return null;
		return { at, id: text.slice(i + 1) };
	} catch {
		return null;
	}
};
