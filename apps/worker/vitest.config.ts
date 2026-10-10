import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	convertToWranglerConfig,
	loadAndParseConfig,
} from "@cloudflare/config";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

// vitest-pool-workers は Wrangler 設定ファイルしか読めないため、
// cloudflare.config.ts から生成して使う（設定の二重管理を避ける）。
async function generateWranglerConfig(): Promise<string> {
	const { result } = await loadAndParseConfig(
		resolve(root, "cloudflare.config.ts"),
		{ isPreview: false, mode: "development" },
	);
	if (!result.success) {
		throw new Error("cloudflare.config.ts の評価に失敗した");
	}
	const {
		secrets: _secrets,
		routes: _routes,
		exports: _exports,
		durable_objects,
		...rest
	} = convertToWranglerConfig(result.data);
	const wrangler = {
		...rest,
		// pool は exports を解釈せず、DO クラスの宣言を migrations から読む。
		// script_name を残すと別 Worker の DO とみなされ自己参照できない。
		durable_objects: {
			bindings: durable_objects?.bindings?.map(
				(b: { script_name?: string }) => {
					const { script_name: _s, ...binding } = b;
					return binding;
				},
			),
		},
		migrations: [{ tag: "v1", new_sqlite_classes: ["PartnerDO"] }],
	};
	const path = resolve(root, ".wrangler/test/wrangler.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(wrangler, null, 2));
	return path;
}

export default defineConfig(async () => {
	const migrations = await readD1Migrations(resolve(root, "migrations"));
	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: await generateWranglerConfig() },
				miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
