import type { PartnerProfile } from "@yunomi/core";
import type { PromptInput } from "./prompt-builder.ts";

export const profile: PartnerProfile = {
	schema_version: 1,
	partner_id: "test-partner",
	display_name: "テスト",
	aliases: ["テスト", "てすと"],
	address_user: "あなた",
	speech: { register: "polite", casualization_limit: 0.3 },
	values: [
		{
			name: "誠実さ",
			kind: "value",
			strength: 0.8,
			description: "嘘をつかない。",
		},
		{
			name: "詮索",
			kind: "boundary",
			strength: 0.9,
			description: "私的な事を聞き出さない。",
		},
	],
	interests: [
		{ topic: "music", label: "音楽", baseline: 0.5, summary: "仮" },
		{ topic: "moon", label: "月", baseline: 0.3, summary: "仮の月" },
	],
	opinions: [
		{
			topic: "pace",
			label: "速さ",
			stance: "ゆっくりがよい。",
			confidence: 0.6,
			stability: 0.5,
		},
	],
	living_rhythm: {
		timezone: "Asia/Tokyo",
		lifestyle_day_boundary: "05:00",
		typical_sleep: "26:00-08:00",
	},
	recurring_jokes: [
		{ id: "joke-a", text_hint: "仮のネタA", cooldown_minutes: 60 },
		{ id: "joke-b", text_hint: "仮のネタB", cooldown_minutes: 60 },
	],
	initial_state: { mood: 0.2, energy: 0.6 },
	initial_relationship: { familiarity: 0.1, trust: 0.3 },
	capability_defaults: {},
	identity: {
		official: "公式設定の仮本文。",
		fanon: "二次設定の仮本文。",
		yunomi: "丁寧で落ち着いた人格の仮本文。",
	},
	examples: [],
};

export const baseInput = (): PromptInput => ({
	profile,
	jokeStatus: { "joke-b": "cooling_down" },
	bodyState: "can_speak",
	state: { mood: 0.25, energy: 0.5 },
	relationship: { speakerName: "alice", familiarity: 0.4, trust: 0.35 },
	memory: [
		{
			subject: "alice",
			predicate: "好きな飲み物",
			object: "緑茶",
			kind: "lasting",
			observedAt: new Date("2026-09-01T03:00:00Z"),
		},
		{
			subject: "alice",
			predicate: "職業",
			object: "エンジニア",
			kind: "lasting",
			observedAt: new Date("2026-09-01T03:00:00Z"),
		},
	],
	interests: [
		{ topic: "music", label: "音楽", score: 0.55, summary: "仮" },
		{ topic: "moon", label: "月", score: 0.3, summary: "仮の月" },
	],
	opinions: [
		{
			topic: "pace",
			label: "速さ",
			stance: "ゆっくりがよい。",
			confidence: 0.6,
		},
	],
	openLoops: [],
	now: new Date("2026-10-11T03:00:00Z"),
	channel: { name: "general", presence: "alice がオンライン" },
	recent: [
		{ speaker: "alice", text: "おはよう" },
		{ speaker: "bob", text: "今日は寒いね" },
	],
	message: {
		speaker: "alice",
		text: "ゆかりん、今日の予定は？",
		mentionsPartner: true,
	},
});
