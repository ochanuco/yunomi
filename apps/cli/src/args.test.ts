import { describe, expect, it } from "vitest";
import { parseCli } from "./args.ts";

const ok = (argv: string[]) => {
	const r = parseCli(argv);
	if (!r.ok) throw new Error(r.message);
	return r;
};

describe("parseCli", () => {
	it("既定は dev / yukarin / 整形出力", () => {
		expect(ok(["status"])).toMatchObject({
			command: { name: "status" },
			global: { env: "dev", url: null, partner: "yukarin", json: false },
		});
	});

	it("共通オプションはコマンドの前後どちらでも受ける", () => {
		const r = ok(["--env", "prod", "memory", "list", "--json", "--limit", "5"]);
		expect(r.global).toMatchObject({ env: "prod", json: true });
		expect(r.command).toEqual({
			name: "memory-list",
			candidates: false,
			all: false,
			limit: 5,
		});
	});

	it("memory list --candidates", () => {
		expect(ok(["memory", "list", "--candidates"]).command).toEqual({
			name: "memory-list",
			candidates: true,
			all: false,
			limit: 20,
		});
	});

	it("memory list --all は Fact に置き換え済み・期限切れを含める", () => {
		expect(ok(["memory", "list", "--all"]).command).toMatchObject({
			name: "memory-list",
			all: true,
		});
		expect(parseCli(["memory", "list", "--all", "--candidates"]).ok).toBe(
			false,
		);
	});

	it("open-loops は --all と --limit を受け、他のオプションは拒否する", () => {
		expect(ok(["open-loops"]).command).toEqual({
			name: "open-loops",
			all: false,
			limit: 20,
		});
		expect(ok(["open-loops", "--all", "--limit", "7"]).command).toEqual({
			name: "open-loops",
			all: true,
			limit: 7,
		});
		expect(parseCli(["open-loops", "--days", "3"]).ok).toBe(false);
		expect(parseCli(["open-loops", "extra"]).ok).toBe(false);
	});

	it("interests / opinions は引数を取らない", () => {
		expect(ok(["interests"]).command).toEqual({ name: "interests" });
		expect(ok(["opinions", "--json"]).command).toEqual({ name: "opinions" });
		expect(parseCli(["interests", "--all"]).ok).toBe(false);
		expect(parseCli(["opinions", "extra"]).ok).toBe(false);
	});

	it("kpi の既定は 30 日、--days で変える", () => {
		expect(ok(["kpi"]).command).toEqual({ name: "kpi", days: 30 });
		expect(ok(["kpi", "--days", "7", "--json"]).command).toEqual({
			name: "kpi",
			days: 7,
		});
		expect(parseCli(["kpi", "--days", "0"]).ok).toBe(false);
		expect(parseCli(["kpi", "--days", "366"]).ok).toBe(false);
		expect(parseCli(["kpi", "--limit", "5"]).ok).toBe(false);
	});

	it("audit tail の -n と -f", () => {
		expect(ok(["audit", "tail", "-n", "50", "-f"]).command).toEqual({
			name: "audit-tail",
			count: 50,
			follow: true,
		});
		expect(ok(["audit", "tail"]).command).toEqual({
			name: "audit-tail",
			count: 20,
			follow: false,
		});
	});

	it("引数なしと --help はヘルプ", () => {
		expect(ok([]).command.name).toBe("help");
		expect(ok(["status", "--help"]).command.name).toBe("help");
	});

	it.each([
		[["status", "--env", "stg"]],
		[["memory", "list", "--limit", "0"]],
		[["memory", "list", "--limit", "201"]],
		[["audit", "tail", "-n", "x"]],
		[["status", "--candidates"]],
		[["audit", "tail", "--limit", "3"]],
		[["status", "extra"]],
		[["memory"]],
		[["unknown"]],
		[["status", "--nope"]],
	])("不正な指定 %j はエラー", (argv) => {
		expect(parseCli(argv).ok).toBe(false);
	});
});
