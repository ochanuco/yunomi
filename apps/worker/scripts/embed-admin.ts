import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// cf/config の assets は配信ディレクトリを指定できないため、apps/admin のビルド成果物を
// Worker のソースに埋め込んで /admin/ 配下で返す。成果物は全て text。
// --allow-missing: 未ビルドなら空で生成する（typecheck / test 用。build では使わない）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "../admin/dist");
const out = join(root, "src/generated/admin-assets.ts");
const allowMissing = process.argv.includes("--allow-missing");

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json; charset=utf-8",
};

const walk = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);

const assets: Record<string, { type: string; body: string }> = {};
if (existsSync(dist)) {
	for (const file of walk(dist)) {
		const type = TYPES[extname(file)];
		if (!type) throw new Error(`埋め込めない拡張子: ${file}`);
		assets[`/${relative(dist, file).split("\\").join("/")}`] = {
			type,
			body: readFileSync(file, "utf8"),
		};
	}
} else if (!allowMissing) {
	throw new Error(
		"apps/admin/dist が無い。先に pnpm --filter @yunomi/admin build を実行する",
	);
} else {
	console.warn("apps/admin/dist が無いので、admin 画面は空で埋め込む");
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
	out,
	`// scripts/embed-admin.ts が生成する。編集しない。\nexport const ADMIN_ASSETS: Record<string, { type: string; body: string }> = ${JSON.stringify(assets, null, "\t")};\n`,
);
