// hook として node で直接動かすため、node の組み込み以外を import しない。
import { basename } from "node:path";
import { absPath, isUnder } from "./operation.ts";
import { type SimpleCommand, splitCommands } from "./shell.ts";

export type GuardContext = {
	/** 作業場所。相対パスはここから解く。 */
	workDir: string;
	home: string;
	/** 読むのも書くのも止める場所（秘密情報、Claude CLI の設定、許可の記録）。 */
	protectedDirs: readonly string[];
};

/** 止める理由。null は hook では止めない（Claude CLI の auto モードが決める）。 */
type Reason = string | null;

export const SECRET_READ = "秘密情報の読み出し";
export const PROTECTED_TOUCH = "秘密情報や設定・許可の記録がある場所に触る";

const SECRET_VAR = /\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/;
const SECRET_FILES = [".credentials.json", ".git-credentials", "/environ"];

/**
 * シェルが変数を展開する部分だけを残す。単一引用符の中、引用符付きの heredoc の本文、`\$` は展開されないので、
 * 報告の本文などに書いた `$GH_TOKEN` という文字で止めない。
 */
const expandable = (raw: string) =>
	raw
		.replace(/<<-?\s*(['"])(\w+)\1[\s\S]*?\n\2(?=\n|$)/g, "")
		.replace(/'[^']*'/g, "''")
		.replace(/\\\$/g, "");

const isFlag = (a: string) => a.startsWith("-") && a !== "-";

/** 先頭の代入と、`command` などの前置きを飛ばした、コマンド名の位置。 */
const commandStart = (args: readonly string[]): number => {
	let i = 0;
	while (i < args.length) {
		const a = args[i] as string;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
			i++;
			continue;
		}
		const name = basename(a);
		if (
			["command", "exec", "time", "nohup", "nice", "builtin"].includes(name)
		) {
			i++;
			while (i < args.length && isFlag(args[i] as string)) i++;
			continue;
		}
		return i;
	}
	return i;
};

type CwdRef = { cwd: string | null };

/** `cd` を追って、相対パスを解く場所を変える。解けなくなったら null。 */
const followCd = (args: readonly string[], ctx: GuardContext, cwd: CwdRef) => {
	const target = args.find((a) => !isFlag(a));
	if (target === undefined) cwd.cwd = ctx.home;
	else if (/[$`]/.test(target)) cwd.cwd = null;
	else if (cwd.cwd === null && !/^[/~]/.test(target)) cwd.cwd = null;
	else cwd.cwd = absPath(target, cwd.cwd ?? ctx.workDir, ctx.home);
};

/** 環境変数やトークンを見せるコマンド。 */
const secretCommand = (cmd: SimpleCommand): Reason => {
	const start = commandStart(cmd.args);
	const head = cmd.args[start];
	if (head === undefined) {
		// `env` だけは環境変数をすべて見せる
		return cmd.args.some((a) => basename(a) === "env") ? SECRET_READ : null;
	}
	const name = basename(head);
	const rest = cmd.args.slice(start + 1);
	if (name === "printenv" || name === "compgen") return SECRET_READ;
	// コマンドを付けない `env` は環境変数をすべて見せる。`env FOO=1 node x` のような実行は通す
	if (
		name === "env" &&
		rest.every((a) => isFlag(a) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))
	) {
		return SECRET_READ;
	}
	if ((name === "set" || name === "export") && rest.every((a) => isFlag(a))) {
		return SECRET_READ;
	}
	if (
		(name === "declare" || name === "typeset") &&
		(rest.length === 0 || rest.some((a) => /^-[A-Za-z]*[xp]/.test(a)))
	) {
		return SECRET_READ;
	}
	if (name === "git" && rest.includes("credential")) return SECRET_READ;
	if (name === "gh") {
		const words = rest.filter((a) => !isFlag(a));
		if (rest.some((a) => a === "--show-token" || a === "-t")) {
			return SECRET_READ;
		}
		if (words[0] === "auth" && words[1] === "token") return SECRET_READ;
	}
	return null;
};

const touchesProtected = (
	raw: string,
	cmds: readonly SimpleCommand[],
	ctx: GuardContext,
): boolean => {
	const expanded = raw
		.replace(/\$\{HOME\}|\$HOME/g, ctx.home)
		.replace(/(^|[\s=:'"])~(?=\/|$|[\s'"])/g, `$1${ctx.home}`);
	if (ctx.protectedDirs.some((d) => expanded.includes(d))) return true;
	if (SECRET_FILES.some((f) => raw.includes(f))) return true;
	const cwd: CwdRef = { cwd: ctx.workDir };
	for (const c of cmds) {
		const start = commandStart(c.args);
		if (c.args[start] === "cd" || c.args[start] === "pushd") {
			followCd(c.args.slice(start + 1), ctx, cwd);
			continue;
		}
		const words = [...c.args, ...c.redirects.map((r) => r.target)];
		for (const w of words) {
			if (cwd.cwd === null || !/[/.~]/.test(w) || /[$`]/.test(w)) continue;
			const abs = absPath(w.replace(/^[^=]*=/, ""), cwd.cwd, ctx.home);
			if (ctx.protectedDirs.some((d) => isUnder(abs, d))) return true;
		}
	}
	return false;
};

/**
 * Bash のコマンドが、秘密情報を読み出すか、秘密情報や許可の記録の場所に触るかを調べる。
 * ほかの取り消せない操作は Claude CLI の auto モードに任せる。
 * 道具の名前と引数で読むので、書き方を変えれば抜けられる。うっかりの読み出しを止めるためのもの。
 */
export const classifyBash = (raw: string, ctx: GuardContext): Reason => {
	if (SECRET_VAR.test(expandable(raw))) return SECRET_READ;
	const cmds = splitCommands(raw);
	if (touchesProtected(raw, cmds, ctx)) return PROTECTED_TOUCH;
	for (const c of cmds) {
		for (const sub of c.substitutions) {
			const r = classifyBash(sub, ctx);
			if (r) return r;
		}
		const r = secretCommand(c);
		if (r) return r;
	}
	return null;
};
