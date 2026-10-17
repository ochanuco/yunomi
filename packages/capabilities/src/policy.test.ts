import { describe, expect, it } from "vitest";
import { decide, rejectionFor } from "./policy.ts";

const policy = {
	calendar_read: "auto",
	calendar_write: "confirm",
	file_write: "deny",
} as const;

const owner = { isOwner: true };
const guest = { isOwner: false };

describe("decide", () => {
	it("オーナーの auto は auto", () => {
		expect(decide(policy, { category: "calendar_read" }, owner)).toEqual({
			type: "auto",
		});
	});

	it("オーナーの confirm は confirm", () => {
		expect(decide(policy, { category: "calendar_write" }, owner)).toEqual({
			type: "confirm",
		});
	});

	it("deny の category は policy_deny", () => {
		expect(decide(policy, { category: "file_write" }, owner)).toEqual({
			type: "deny",
			reason: "policy_deny",
		});
	});

	it("policy に無い category は unknown_category", () => {
		expect(decide(policy, { category: "gmail_read" }, owner)).toEqual({
			type: "deny",
			reason: "unknown_category",
		});
	});

	it("継承されたプロパティ名は category として拾わない", () => {
		expect(decide(policy, { category: "constructor" }, owner)).toEqual({
			type: "deny",
			reason: "unknown_category",
		});
	});

	it("オーナー以外は auto の category でも not_owner", () => {
		expect(decide(policy, { category: "calendar_read" }, guest)).toEqual({
			type: "deny",
			reason: "not_owner",
		});
	});

	it("オーナー以外は未定義・deny の category でも not_owner が先に出る", () => {
		expect(decide(policy, { category: "gmail_read" }, guest)).toEqual({
			type: "deny",
			reason: "not_owner",
		});
		expect(decide(policy, { category: "file_write" }, guest)).toEqual({
			type: "deny",
			reason: "not_owner",
		});
	});
});

describe("rejectionFor", () => {
	it("deny の決定から ToolExecutionRejected を作る", () => {
		const error = rejectionFor(
			{ name: "calendar_create_event" },
			{ type: "deny", reason: "not_owner" },
		);
		expect(error.type).toBe("ToolExecutionRejected");
		expect(error.tool).toBe("calendar_create_event");
		expect(error.reason).toBe("not_owner");
	});
});
