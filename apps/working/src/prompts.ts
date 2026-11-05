import { formatJstForPrompt } from "@yunomi/core";
import type { PostedMessage } from "./discord-rest.ts";

/** persona.sh の出力の後ろに足す。仕事の場での振る舞いと、状態の書き方を決める。 */
export const WORKING_INSTRUCTIONS = `
## 仕事のしかた

あなたはいま Discord の仕事フォーラムの投稿で、頼まれた仕事をしている。あなたの返事はそのままその投稿に書き込まれる。

- 返事は Discord のメッセージとして読める長さと書式にする。
- 使える道具は読み取りだけ。書き込みや実行が要るときは、何をしたいかを書いて相手に決めてもらう。
- 返事の最後の行に、投稿の状態を次のどれか 1 つで書く。この行は投稿には出ず、投稿のタグになる。
  - \`状態: 決めてほしい\`: 相手の判断や情報を待っている
  - \`状態: 引き継ぎ\`: この環境ではできず、Mac の agent に任せたい
  - \`状態: 完了\`: 頼まれたことが終わった
`;

/** 人格、仕事のしかた、Mac への引き継ぎの指示、申し送りの雛形の順に並べる。 */
export const systemPrompt = (input: {
	persona: string;
	handoffPrompt: string;
	handoffTemplate: string;
}) =>
	[
		input.persona.trimEnd(),
		WORKING_INSTRUCTIONS.trim(),
		input.handoffPrompt.trim(),
		`### 申し送りの雛形\n\n\`\`\`markdown\n${input.handoffTemplate.trim()}\n\`\`\``,
	].join("\n\n") + "\n";

const clock = (now: Date) => `いま: ${formatJstForPrompt(now)}`;

export const messageLink = (
	guildId: string,
	channelId: string,
	messageId?: string,
) =>
	`https://discord.com/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`;

const MENTION = /<@[!&]?\d+>/g;

/** 要約が取れないときの件名。依頼の 1 行目を切り詰める。 */
export const fallbackTitle = (content: string): string => {
	const first =
		content
			.replace(MENTION, "")
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l !== "") ?? "";
	if (first === "") return "仕事の依頼";
	return first.length > 40 ? `${first.slice(0, 40)}…` : first;
};

const quote = (text: string, limit: number) => {
	const body = text.length > limit ? `${text.slice(0, limit)}…` : text;
	return body
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
};

export const forumPostBody = (input: {
	authorName: string;
	content: string;
	link: string;
}) =>
	`${input.authorName} さんからの依頼\n\n${quote(input.content, 1500)}\n\n元のメッセージ: ${input.link}`;

export const requestPrompt = (input: {
	now: Date;
	authorName: string;
	content: string;
	link: string;
}) =>
	`${clock(input.now)}
${input.authorName} さんから仕事チャンネルで依頼があり、この投稿を立てた。この投稿で作業して返事をする。
元のメッセージ: ${input.link}

依頼:
${input.content}`;

export const forumStarterPrompt = (input: {
	now: Date;
	authorName: string;
	title: string | null;
	content: string;
}) =>
	`${clock(input.now)}
${input.authorName} さんが仕事フォーラムに投稿した。この投稿で作業して返事をする。
件名: ${input.title ?? "（なし）"}

本文:
${input.content}`;

export const replyPrompt = (input: {
	now: Date;
	authorName: string;
	content: string;
}) => `${clock(input.now)}
${input.authorName}: ${input.content}`;

export const recoveryPrompt = (input: {
	now: Date;
	title: string | null;
	history: readonly PostedMessage[];
	botUserId: string;
}) => {
	const lines = input.history.map(
		(m) =>
			`[${m.authorId === input.botUserId ? "あなた" : m.authorName}] ${m.content}`,
	);
	return `${clock(input.now)}
この投稿で続けていた作業の記憶が失われた。これまでのやりとりを読み、最後の発言に答えて続きをする。
件名: ${input.title ?? "（なし）"}

--- これまでのやりとり ---
${lines.join("\n\n")}
--- ここまで ---`;
};
