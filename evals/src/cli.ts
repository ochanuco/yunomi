import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ClaudeProvider, type Env, type LLMProvider } from "@yunomi/llm";
import { profileVersion, yukarinProfile } from "@yunomi/partner-yukarin";
import { loadScenarios } from "./scenario.ts";
import { formatSummary, runTier2 } from "./tier2.ts";

export const defaultOutDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../out",
);

export type CliDeps = {
	/** テストでは Fake を返す。実行時の既定は ClaudeProvider。 */
	createProvider: (apiKey: string) => LLMProvider;
	env: Record<string, string | undefined>;
	outDir?: string;
	scenariosDir?: string;
	now?: () => Date;
	log?: (msg: string) => void;
};

export const defaultDeps = (
	env: Record<string, string | undefined>,
): CliDeps => ({
	createProvider: (apiKey) => new ClaudeProvider({ apiKey, timeoutMs: 60_000 }),
	env,
});

const parseEnv = (s: string): Env | null =>
	s === "development" || s === "production" ? s : null;

/** 終了コードを返す。--strict で閾値違反があるとき、または引数・認証の誤りのとき 0 以外。 */
export const main = async (argv: string[], deps: CliDeps): Promise<number> => {
	const log = deps.log ?? ((m: string) => console.log(m));
	let values: {
		samples?: string;
		env?: string;
		strict?: boolean;
		scenario?: string[];
	};
	try {
		({ values } = parseArgs({
			args: argv,
			options: {
				samples: { type: "string" },
				env: { type: "string" },
				strict: { type: "boolean" },
				scenario: { type: "string", multiple: true },
			},
		}));
	} catch (e) {
		log(`引数が不正: ${(e as Error).message}`);
		return 2;
	}

	const samples = Number(values.samples ?? 5);
	if (!Number.isInteger(samples) || samples < 1) {
		log("--samples は 1 以上の整数");
		return 2;
	}
	const env = parseEnv(values.env ?? "development");
	if (!env) {
		log("--env は development か production");
		return 2;
	}
	const apiKey = deps.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		log("ANTHROPIC_API_KEY が未設定");
		return 2;
	}

	let scenarios = loadScenarios(deps.scenariosDir, yukarinProfile);
	if (values.scenario?.length) {
		const want = new Set(values.scenario);
		scenarios = scenarios.filter((s) => want.has(s.id));
		const missing = [...want].filter(
			(id) => !scenarios.some((s) => s.id === id),
		);
		if (missing.length > 0) {
			log(`未知のシナリオ id: ${missing.join(", ")}`);
			return 2;
		}
	}

	const report = await runTier2({
		provider: deps.createProvider(apiKey),
		env,
		profile: yukarinProfile,
		profileVersion,
		scenarios,
		samples,
		now: deps.now,
		onProgress: log,
	});

	const outDir = deps.outDir ?? defaultOutDir;
	mkdirSync(outDir, { recursive: true });
	const stamp = report.meta.timestamp.replace(/[:.]/g, "-");
	const file = join(outDir, `tier2-${stamp}.json`);
	writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

	log(formatSummary(report));
	log(`\nJSON: ${file}`);
	return values.strict && report.violations.length > 0 ? 1 : 0;
};
