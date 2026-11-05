// hook として node で直接動かすため、node の組み込み以外を import しない。
import { basename } from "node:path";
import { absPath, isUnder } from "./operation.ts";
import { type SimpleCommand, splitCommands } from "./shell.ts";

export type GuardContext = {
	/** 作業場所。ここの中のファイルは自由に編集・削除してよい。 */
	workDir: string;
	home: string;
	/** 読むのも書くのも止める場所（秘密情報、Claude CLI の設定、許可の記録）。 */
	protectedDirs: readonly string[];
};

/** 止める理由。null は止めない。 */
type Reason = string | null;

const SECRET_VAR = /\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/;
const SECRET_FILES = [".credentials.json", ".git-credentials", "/environ"];
const SAFE_WRITE_DIRS = ["/dev", "/tmp"];

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS: Record<string, readonly string[]> = {
	node: ["-e", "--eval", "-p", "--print"],
	python: ["-c"],
	python3: ["-c"],
	perl: ["-e", "-E"],
	ruby: ["-e"],
	php: ["-r"],
	bun: ["-e", "--eval", "-p", "--print"],
	deno: ["eval"],
};
/** 呼ぶだけで外に出る・デプロイや課金に届く・秘密を扱う道具。 */
const EXTERNAL_TOOLS = new Set([
	"wrangler",
	"cf",
	"vercel",
	"netlify",
	"fly",
	"flyctl",
	"firebase",
	"heroku",
	"gcloud",
	"gsutil",
	"bq",
	"aws",
	"az",
	"kubectl",
	"helm",
	"pulumi",
	"tofu",
	"terraform",
	"stripe",
	"op",
	"doppler",
	"vault",
	"docker",
	"podman",
	"ssh",
	"scp",
	"sftp",
	"nc",
	"ncat",
	"telnet",
	"socat",
	"http",
	"https",
	"xh",
]);
const PRIVILEGE = new Set(["sudo", "su", "doas"]);
const PROCESS_CONTROL = new Set([
	"kill",
	"pkill",
	"killall",
	"shutdown",
	"reboot",
	"halt",
	"poweroff",
	"systemctl",
	"crontab",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "turbo"]);
const RELEASE_WORDS = new Set([
	"publish",
	"unpublish",
	"deploy",
	"release",
	"dist-tag",
	"owner",
	"login",
	"adduser",
	"token",
]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);

/** gh で聞かずに使ってよいサブコマンド。読み取りと、issue・PR の作成とコメント。 */
const GH_ALLOWED: Record<string, ReadonlySet<string> | "any"> = {
	issue: new Set(["create", "comment", "view", "list", "status"]),
	pr: new Set([
		"create",
		"comment",
		"view",
		"list",
		"status",
		"diff",
		"checks",
		"checkout",
	]),
	label: new Set(["create", "list"]),
	repo: new Set(["view", "clone", "list"]),
	run: new Set(["list", "view", "watch"]),
	search: "any",
	status: "any",
	auth: new Set(["status"]),
};

const isFlag = (a: string) => a.startsWith("-") && a !== "-";

/** 前に付く変数の代入とラッパー（env、timeout、xargs、npx など）を飛ばし、本体の位置を返す。 */
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
		if (name === "env") {
			i++;
			while (i < args.length) {
				const b = args[i] as string;
				if (b === "-u" || b === "-C" || b === "-S") i += 2;
				else if (isFlag(b) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(b)) i++;
				else break;
			}
			continue;
		}
		if (name === "timeout") {
			i++;
			while (i < args.length && isFlag(args[i] as string)) i++;
			i++;
			continue;
		}
		if (name === "xargs") {
			i++;
			while (i < args.length && isFlag(args[i] as string)) {
				const b = args[i] as string;
				i += /^-[IndPLEs]$/.test(b) ? 2 : 1;
			}
			continue;
		}
		if (name === "npx" || name === "bunx") {
			i++;
			while (i < args.length && isFlag(args[i] as string)) i++;
			continue;
		}
		if (
			(name === "pnpm" || name === "yarn" || name === "npm") &&
			["dlx", "exec"].includes(args[i + 1] ?? "")
		) {
			i += 2;
			while (i < args.length && isFlag(args[i] as string)) i++;
			continue;
		}
		return i;
	}
	return i;
};

const classifyGitPush = (rest: readonly string[]): Reason => {
	const positionals: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i] as string;
		if (!isFlag(a)) {
			positionals.push(a);
			continue;
		}
		if (
			["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(a)
		) {
			i++;
			continue;
		}
		if (
			/^--(force|force-with-lease|force-if-includes|mirror|all|branches|tags|follow-tags|prune|delete)(=|$)/.test(
				a,
			)
		) {
			return "force push・削除・まとめての push";
		}
		if (/^-[A-Za-z]+$/.test(a) && /[fd]/.test(a)) {
			return "force push・削除・まとめての push";
		}
	}
	const [remote, ...refspecs] = positionals;
	if (refspecs.length === 0) return "押し先のブランチを書いていない push";
	if (remote !== "origin") return "origin 以外への push";
	for (const spec of refspecs) {
		if (spec.startsWith("+")) return "force push・削除・まとめての push";
		const colon = spec.indexOf(":");
		const src = colon === -1 ? spec : spec.slice(0, colon);
		const dst = (colon === -1 ? spec : spec.slice(colon + 1)).replace(
			/^refs\/heads\//,
			"",
		);
		if (colon !== -1 && src === "") return "force push・削除・まとめての push";
		if (!/^dev\/[A-Za-z0-9._/-]+$/.test(dst) || dst.includes("..")) {
			return "dev/ 以外のブランチへの push";
		}
	}
	return null;
};

const classifyGit = (rest: readonly string[]): Reason => {
	let i = 0;
	while (i < rest.length && isFlag(rest[i] as string)) {
		i += ["-C", "-c"].includes(rest[i] as string) ? 2 : 1;
	}
	const sub = rest[i];
	const tail = rest.slice(i + 1);
	switch (sub) {
		case "push":
			return classifyGitPush(tail);
		case "branch":
			return tail.some(
				(a) => a === "--delete" || (/^-[A-Za-z]+$/.test(a) && /[dD]/.test(a)),
			)
				? "ブランチの削除"
				: null;
		case "credential":
			return "秘密情報の読み出し";
		case "config":
			return tail.some((a) =>
				["--global", "--system", "--file", "-f"].includes(a),
			) && !tail.some((a) => /^--get|^--list$|^-l$/.test(a))
				? "作業場所の外の git 設定の変更"
				: null;
		default:
			return null;
	}
};

const classifyGh = (rest: readonly string[]): Reason => {
	if (rest.some((a) => a === "--show-token" || a === "-t")) {
		return "秘密情報の読み出し";
	}
	const words: string[] = [];
	for (let i = 0; i < rest.length && words.length < 2; i++) {
		const a = rest[i] as string;
		if (a === "-R" || a === "--repo" || a === "--hostname") {
			i++;
			continue;
		}
		if (isFlag(a)) continue;
		words.push(a);
	}
	const [group, action] = words;
	const allowed = group === undefined ? undefined : GH_ALLOWED[group];
	if (allowed === "any") return null;
	if (allowed && action !== undefined && allowed.has(action)) return null;
	return `gh ${words.join(" ")} は聞かずに使える操作に入っていない`;
};

const classifyCurl = (rest: readonly string[]): Reason => {
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i] as string;
		if (
			/^--(data|data-raw|data-binary|data-urlencode|json|form|form-string|upload-file)(=|$)/.test(
				a,
			)
		) {
			return "外への送信";
		}
		const method = a.startsWith("--request")
			? (a.split("=")[1] ?? rest[i + 1])
			: /^-[A-Za-z]*X/.test(a)
				? a.slice(a.indexOf("X") + 1) || rest[i + 1]
				: null;
		if (method !== null && !/^(GET|HEAD)$/i.test(method ?? "")) {
			return "外への送信";
		}
		if (/^-[A-Za-z]+$/.test(a) && /[dFT]/.test(a.replace(/X.*/, ""))) {
			return "外への送信";
		}
	}
	return null;
};

const classifyWget = (rest: readonly string[]): Reason =>
	rest.some((a) =>
		/^--(post-data|post-file|method|body-data|body-file)(=|$)/.test(a),
	)
		? "外への送信"
		: null;

/**
 * Working の記憶の口を呼ぶ CLI。Worker に書くので外への送信だが、決まったことと終わったことを
 * 1 行ずつ残すのは仕事のしかたに入れてあるので、read と write の決まった形だけは聞かずに通す。
 */
const classifyMemory = (rest: readonly string[]): Reason => {
	const [sub, ...flags] = rest;
	if (sub === "read" && flags.length === 0) return null;
	if (sub !== "write")
		return "yunomi-memory は read と write だけを聞かずに使える";
	const seen = new Set<string>();
	for (let i = 0; i < flags.length; i++) {
		const a = flags[i] as string;
		const m = /^--(kind|summary)(=.*)?$/.exec(a);
		if (!m || seen.has(m[1] as string)) {
			return "yunomi-memory write は --kind と --summary だけを聞かずに使える";
		}
		seen.add(m[1] as string);
		if (m[2] === undefined) i++;
	}
	return null;
};

/** 席の Claude が受付とやりとりする orchestration の口。席を作る・止める・ほかの席に送る操作は通さない。 */
const ORCA_SEAT_VERBS = new Set(["ask", "send", "check"]);

const classifyOrca = (rest: readonly string[]): Reason => {
	const [group, verb] = rest;
	if (group === "orchestration" && verb && ORCA_SEAT_VERBS.has(verb)) {
		return rest.some((a) => /^--(to|pairing-code|environment)(=|$)/.test(a))
			? "orca orchestration の宛先を変える操作"
			: null;
	}
	if (group === "skills" && verb === "get") return null;
	return "orca は席の Claude が受付とやりとりする orchestration の口だけを聞かずに使える";
};

type CwdRef = { cwd: string | null };

const pathsOf = (rest: readonly string[]) => {
	const out: string[] = [];
	let endOfFlags = false;
	for (const a of rest) {
		if (!endOfFlags && a === "--") {
			endOfFlags = true;
			continue;
		}
		if (!endOfFlags && isFlag(a)) continue;
		out.push(a);
	}
	return out;
};

/** 作業場所の中（作業場所そのものは除く）を指しているか。解決できないものは外とみなす。 */
const insideWork = (p: string, ctx: GuardContext, cwd: CwdRef): boolean => {
	if (/[$`]/.test(p)) return false;
	if (cwd.cwd === null && !p.startsWith("/") && !p.startsWith("~"))
		return false;
	const abs = absPath(p, cwd.cwd ?? ctx.workDir, ctx.home);
	return abs !== ctx.workDir && isUnder(abs, ctx.workDir);
};

const classifySimple = (
	cmd: SimpleCommand,
	ctx: GuardContext,
	cwd: CwdRef,
): Reason => {
	for (const sub of cmd.substitutions) {
		const r = classifyBash(sub, ctx, { cwd: cwd.cwd });
		if (r) return r;
	}
	for (const r of cmd.redirects) {
		if (r.mode !== "write") continue;
		if (/[$`]/.test(r.target)) return "作業場所の外への書き込み";
		const abs = absPath(r.target, cwd.cwd ?? ctx.workDir, ctx.home);
		if (
			!isUnder(abs, ctx.workDir) &&
			!SAFE_WRITE_DIRS.some((d) => isUnder(abs, d))
		) {
			return "作業場所の外への書き込み";
		}
	}

	const start = commandStart(cmd.args);
	const head = cmd.args[start];
	if (head === undefined) {
		// `env` だけ・代入だけは環境変数を見せるか設定するだけ
		return cmd.args.some((a) => basename(a) === "env")
			? "秘密情報の読み出し"
			: null;
	}
	const name = basename(head);
	const rest = cmd.args.slice(start + 1);

	if (name === "cd" || name === "pushd") {
		const target = rest.find((a) => !isFlag(a));
		if (target === undefined) cwd.cwd = ctx.home;
		else if (/[$`]/.test(target)) cwd.cwd = null;
		else if (cwd.cwd === null && !/^[/~]/.test(target)) cwd.cwd = null;
		else cwd.cwd = absPath(target, cwd.cwd ?? ctx.workDir, ctx.home);
		return null;
	}
	if (PRIVILEGE.has(name)) return "権限の昇格";
	if (PROCESS_CONTROL.has(name)) return "プロセスやシステムの操作";
	if (EXTERNAL_TOOLS.has(name))
		return `${name} は外に出る・デプロイや課金に届く道具`;
	if (SHELLS.has(name)) {
		const script = rest.find((a) => !isFlag(a));
		return rest.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) ||
			script === undefined
			? "中身を読めないコマンドの実行"
			: null;
	}
	if (name === "eval") return "中身を読めないコマンドの実行";
	const inline = INTERPRETERS[name];
	if (inline && rest.some((a) => inline.includes(a))) {
		return "中身を読めないコマンドの実行";
	}
	if (name === "printenv" || name === "compgen") return "秘密情報の読み出し";
	if ((name === "set" || name === "export") && rest.every((a) => isFlag(a))) {
		return "秘密情報の読み出し";
	}
	if (
		(name === "declare" || name === "typeset") &&
		(rest.length === 0 || rest.some((a) => /^-[A-Za-z]*[xp]/.test(a)))
	) {
		return "秘密情報の読み出し";
	}
	if (name === "yunomi-memory") return classifyMemory(rest);
	if (name === "orca" || name === "orca-ide") return classifyOrca(rest);
	if (name === "git") return classifyGit(rest);
	if (name === "gh") return classifyGh(rest);
	if (name === "curl") return classifyCurl(rest);
	if (name === "wget") return classifyWget(rest);
	if (name === "rsync" && rest.some((a) => !isFlag(a) && /^[^/]*:/.test(a))) {
		return "外への送信";
	}
	if (
		PACKAGE_MANAGERS.has(name) &&
		rest.some(
			(a) => RELEASE_WORDS.has(a) || /:(deploy|publish|release)$/.test(a),
		)
	) {
		return "公開・デプロイ";
	}
	if (DELETERS.has(name)) {
		return pathsOf(rest).every((p) => insideWork(p, ctx, cwd))
			? null
			: "作業場所の外の削除";
	}
	if (name === "mv") {
		return pathsOf(rest).every((p) => insideWork(p, ctx, cwd))
			? null
			: "作業場所の外のファイルの移動";
	}
	if (name === "find") {
		const startPaths: string[] = [];
		for (const a of rest) {
			if (a.startsWith("-") || a === "(" || a === "!") break;
			startPaths.push(a);
		}
		if (startPaths.length === 0) startPaths.push(".");
		if (
			rest.includes("-delete") &&
			!startPaths.every((p) =>
				insideWork(`${p.replace(/\/$/, "")}/x`, ctx, cwd),
			)
		) {
			return "作業場所の外の削除";
		}
		for (let i = 0; i < rest.length; i++) {
			if (!["-exec", "-execdir", "-ok", "-okdir"].includes(rest[i] as string)) {
				continue;
			}
			const end = rest.findIndex((a, j) => j > i && (a === ";" || a === "+"));
			const nested = rest.slice(i + 1, end === -1 ? rest.length : end);
			const r = classifySimple(
				{ args: nested, redirects: [], substitutions: [] },
				ctx,
				{ cwd: cwd.cwd },
			);
			if (r) return r;
		}
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
			classifySimple(c, ctx, cwd);
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
 * Bash のコマンドを、聞かずに実行してよいか調べる。止めるときは理由を返す。
 * 道具の名前と引数で読むので、書き方を変えれば抜けられる。うっかりの実行を止めるためのもので、
 * main への push やマージは GitHub 側の保護と書き込みトークンの権限でも止める。
 */
export const classifyBash = (
	raw: string,
	ctx: GuardContext,
	cwd: CwdRef = { cwd: ctx.workDir },
): Reason => {
	if (SECRET_VAR.test(raw)) return "秘密情報の読み出し";
	const cmds = splitCommands(raw);
	if (touchesProtected(raw, cmds, ctx)) {
		return "秘密情報や設定・許可の記録がある場所に触る";
	}
	for (const c of cmds) {
		const r = classifySimple(c, ctx, cwd);
		if (r) return r;
	}
	return null;
};
