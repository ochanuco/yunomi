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
			limit: 5,
		});
	});

	it("memory list --candidates", () => {
		expect(ok(["memory", "list", "--candidates"]).command).toEqual({
			name: "memory-list",
			candidates: true,
			limit: 20,
		});
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
