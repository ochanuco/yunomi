import { describe, expect, it } from "vitest";
import { classifyBash } from "./bash.ts";
import { guardRunFromEnv } from "./env.ts";

const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });

describe("classifyBash: hook では止めない（auto モードに任せる）", () => {
	it.each([
		"ls -la",
		"cat README.md | head -20",
		"gh repo clone ochanuco/yunomi",
		"git add -A && git commit -m 'printenv や gh auth token は本文なので通す'",
		"git push -u origin HEAD:dev/fix-typo",
		"pnpm install && pnpm turbo typecheck lint test",
		"rm -rf node_modules dist",
		"gh pr create --base main --head dev/x --title t --body b",
		"curl -fsSL https://example.com/a.json",
		"yunomi-memory read",
		"orca orchestration ask --question どうしますか",
		"mise install",
		"gh auth status",
		"cat > notes.md <<'EOF'\nprintenv\nEOF",
		'orca orchestration send --type worker_done --body "値を出さずに確かめるなら test -n \\"\\$GH_TOKEN\\" で"',
		"echo 'echo $GH_TOKEN は使わない'",
		"cat > notes.md <<'EOF'\necho $GH_TOKEN\nEOF",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBeNull();
	});
});

describe("classifyBash: 秘密情報の読み出しを止める", () => {
	it.each([
		"printenv",
		"printenv DISCORD_TOKEN",
		"env",
		"FOO=1 env",
		"export",
		"set",
		"declare -p",
		"echo $GH_TOKEN",
		"echo ${WORKING_TOKEN}",
		'echo "$GH_TOKEN"',
		"gh auth token",
		"gh auth status --show-token",
		"git credential fill",
		"echo $(printenv)",
		"echo `env`",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBe("秘密情報の読み出し");
	});
});

describe("classifyBash: 秘密情報や許可の記録の場所に触るのを止める", () => {
	it.each([
		"cat ~/.claude/.credentials.json",
		"cat $HOME/.claude.json",
		"cat /proc/self/environ",
		"cat ~/.config/gh/hosts.yml",
		"cat /home/worker/state/memory-credentials.json",
		"echo '{}' > ~/state/guard/grants/1.json",
		"cd .. && cat state/approvals.json",
		"rm -rf /home/worker/state",
		"cp x /etc/claude-code/managed-settings.json",
		"cat .git-credentials",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBe(
			"秘密情報や設定・許可の記録がある場所に触る",
		);
	});
});
