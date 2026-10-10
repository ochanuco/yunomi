import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	convertToWranglerConfig,
	loadAndParseConfig,
} from "@cloudflare/config";

// cf d1 migrations apply --local は cf dev と別の state を見て確認待ちで止まるため、
// cf dev と同じ .wrangler/state に対して wrangler で適用する。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { result } = await loadAndParseConfig(
	resolve(root, "cloudflare.config.ts"),
	{ isPreview: false, mode: "local" },
);
if (!result.success) {
	throw new Error("cloudflare.config.ts (local) の評価に失敗した");
}
const wrangler = convertToWranglerConfig(result.data);
const config = {
	name: wrangler.name,
	compatibility_date: wrangler.compatibility_date,
	d1_databases: wrangler.d1_databases?.map((db: object) => ({
		...db,
		migrations_dir: resolve(root, "migrations"),
	})),
};
const configPath = resolve(root, ".wrangler/local/wrangler.migrate.json");
mkdirSync(dirname(configPath), { recursive: true });
writeFileSync(configPath, JSON.stringify(config, null, 2));

const run = spawnSync(
	"wrangler",
	[
		"d1",
		"migrations",
		"apply",
		"DB",
		"--local",
		"-c",
		configPath,
		"--persist-to",
		resolve(root, ".wrangler/state"),
	],
	{ cwd: root, stdio: "inherit", env: { ...process.env, CI: "1" } },
);
process.exit(run.status ?? 1);
