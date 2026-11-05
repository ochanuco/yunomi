// hook として node で直接動かすため、node の組み込み以外を import しない（node_modules の .ts は型を剥がせない）。
import { isAbsolute, resolve } from "node:path";

/** 許可の単位。同じ道具に同じ対象を渡すときだけ同じ操作とみなす。 */
export type Operation = { tool: string; target: string };

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

export const absPath = (p: string, cwd: string, home: string): string => {
	const expanded = p === "~" ? home : p.replace(/^~\//, `${home}/`);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
};

export const operationOf = (
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
	home: string,
): Operation => {
	if (tool === "Bash") {
		return { tool, target: (str(input.command) ?? "").trim() };
	}
	const path = str(input.file_path) ?? str(input.notebook_path);
	if (path !== null) return { tool, target: absPath(path, cwd, home) };
	if (tool === "Glob" || tool === "Grep") {
		const dir = absPath(str(input.path) ?? cwd, cwd, home);
		return { tool, target: `${dir} ${str(input.pattern) ?? ""}`.trim() };
	}
	return { tool, target: JSON.stringify(input) };
};

export const sameOperation = (a: Operation, b: Operation) =>
	a.tool === b.tool && a.target === b.target;

export const isUnder = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`);
