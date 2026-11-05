// Claude CLI の PreToolUse hook。道具を使う前に呼ばれ、聞かずに実行してよいかを返す。
// 例外で落ちると Claude CLI は hook の失敗を無視して進むので、どんな失敗も exit 2（止める）にする。
import { readFileSync } from "node:fs";
import { decide, type HookInput } from "./decide.ts";
import { guardRunFromEnv } from "./env.ts";
import { createLedger } from "./ledger.ts";

try {
	const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
	if (
		typeof input.tool_name !== "string" ||
		typeof input.tool_input !== "object"
	) {
		throw new Error("hook input is malformed");
	}
	const run = guardRunFromEnv(process.env);
	const d = decide(input, run, createLedger(run.guardDir));
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: d.decision,
				permissionDecisionReason: d.reason,
			},
		}),
	);
	process.exit(0);
} catch (e) {
	process.stderr.write(`guard failed: ${String(e)}\n`);
	process.exit(2);
}
