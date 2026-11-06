import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import {
	type GoalAddInput,
	type GoalCloseInput,
	goalAdd,
	goalClose,
} from "../definitions/goal.ts";
import { parseToolInput } from "../input.ts";

export type GoalStoreError =
	| { type: "duplicate" }
	| { type: "limit" }
	| { type: "not_found" }
	| { type: "unavailable" };

/** 目標の置き場所。Worker が D1 で実装する。持ち主は Discord の user id で指す。 */
export type GoalStore = {
	add(input: {
		partnerId: string;
		discordUserId: string;
		summary: string;
		now: Date;
	}): Promise<Result<{ id: string; summary: string }, GoalStoreError>>;
	close(input: {
		partnerId: string;
		discordUserId: string;
		id: string;
		status: GoalCloseInput["status"];
		now: Date;
	}): Promise<Result<{ id: string; summary: string }, GoalStoreError>>;
};

// gate は失敗の型名しかモデルに渡さないので、オーナーに言い分けたい結果は失敗にせず data で返す。
const NOTE: Record<Exclude<GoalStoreError["type"], "unavailable">, string> = {
	duplicate: "同じ目標がもうある。",
	limit: "目標の数が上限に達している。閉じられる目標がないかオーナーに聞く。",
	not_found: "その id の目標は無いか、もう閉じてある。",
};

const outcome = (e: GoalStoreError): Result<CapabilityResponse, DomainError> =>
	e.type === "unavailable"
		? err(externalServiceUnavailable({ service: "goals" }))
		: ok({
				data: { status: "not_done", reason: e.type, note: NOTE[e.type] },
				summary: `目標を変えなかった (${e.type})`,
			});

/**
 * オーナーの目標を足す・閉じる道具。gate がオーナー以外を先に拒否するので、話し手の目標として書く。
 * summary に目標の文面は入れない（Audit に会話の中身を残さない）。
 */
export const createGoalAdapter = (deps: {
	store: GoalStore;
}): CapabilityAdapter => {
	const add = async (
		input: GoalAddInput,
		ctx: { partnerId: string; speakerId: string; now: Date },
	): Promise<Result<CapabilityResponse, DomainError>> => {
		const r = await deps.store.add({
			partnerId: ctx.partnerId,
			discordUserId: ctx.speakerId,
			summary: input.summary,
			now: ctx.now,
		});
		if (!r.ok) return outcome(r.error);
		return ok({
			data: { status: "added", id: r.value.id, summary: r.value.summary },
			summary: "目標を 1 件足した",
		});
	};

	const close = async (
		input: GoalCloseInput,
		ctx: { partnerId: string; speakerId: string; now: Date },
	): Promise<Result<CapabilityResponse, DomainError>> => {
		const r = await deps.store.close({
			partnerId: ctx.partnerId,
			discordUserId: ctx.speakerId,
			id: input.id,
			status: input.status,
			now: ctx.now,
		});
		if (!r.ok) return outcome(r.error);
		return ok({
			data: { status: input.status, id: r.value.id, summary: r.value.summary },
			summary: `目標を 1 件閉じた (${input.status})`,
		});
	};

	return {
		tools: [goalAdd, goalClose],
		async execute(request) {
			const ctx = request.context;
			if (request.tool === goalAdd.name) {
				const input = parseToolInput(goalAdd, request.input);
				return input.ok ? add(input.value, ctx) : input;
			}
			if (request.tool === goalClose.name) {
				const input = parseToolInput(goalClose, request.input);
				return input.ok ? close(input.value, ctx) : input;
			}
			return err(validationFailed({ issues: [`未知の道具: ${request.tool}`] }));
		},
	};
};
