// hook として node で直接動かすため、node の組み込み以外を import しない。
import { join } from "node:path";
import type { GuardRun } from "./decide.ts";
import type { Operation } from "./operation.ts";

/** 受付が Claude CLI に渡し、Claude CLI が hook に引き継ぐ環境変数。 */
export const GUARD_ENV = {
	workDir: "YUNOMI_WORK_DIR",
	stateDir: "YUNOMI_STATE_DIR",
	threadId: "YUNOMI_THREAD_ID",
	grants: "YUNOMI_GRANTS",
	grantId: "YUNOMI_GRANT_ID",
} as const;

export const guardDirOf = (stateDir: string) => join(stateDir, "guard");

const parseGrants = (raw: string | undefined): Operation[] => {
	if (!raw) return [];
	try {
		const v: unknown = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v.filter(
			(x): x is Operation =>
				typeof x === "object" &&
				x !== null &&
				typeof (x as Operation).tool === "string" &&
				typeof (x as Operation).target === "string",
		);
	} catch {
		return [];
	}
};

export const guardRunFromEnv = (
	env: Record<string, string | undefined>,
): GuardRun & { guardDir: string } => {
	const home = env.HOME ?? "/home/worker";
	const stateDir = env[GUARD_ENV.stateDir] ?? `${home}/state`;
	const claudeDir = env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`;
	const grantId = env[GUARD_ENV.grantId];
	return {
		ctx: {
			workDir: env[GUARD_ENV.workDir] ?? `${home}/work`,
			home,
			protectedDirs: [
				claudeDir,
				`${home}/.claude.json`,
				`${home}/.config`,
				`${home}/.ssh`,
				`${home}/.gitconfig`,
				`${home}/.git-credentials`,
				stateDir,
				"/etc/claude-code",
				"/opt/yunomi-guard",
				"/proc",
			],
		},
		threadId: env[GUARD_ENV.threadId] ?? "_",
		grants: parseGrants(env[GUARD_ENV.grants]),
		grantId: grantId ? grantId : null,
		guardDir: guardDirOf(stateDir),
	};
};
