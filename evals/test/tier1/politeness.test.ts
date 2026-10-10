import { describe, expect, it } from "vitest";
import {
	endsWithQuestion,
	politenessScore,
	stripQuoted,
} from "../../src/politeness.ts";

describe("politenessScore", () => {
	it("全文が丁寧語尾なら 1", () => {
		expect(politenessScore("おはようございます。今日は晴れていますね。")).toBe(
			1,
		);
		expect(politenessScore("無理はなさらないでください。")).toBe(1);
		expect(politenessScore("それはありません。そうでしょう。")).toBe(1);
	});

	it("終助詞が付いても丁寧語尾を認識する", () => {
		expect(politenessScore("いいですよ。そうしましょうね。")).toBe(1);
		expect(politenessScore("どうでしょうか。ご存じですか？")).toBe(1);
	});

	it("くだけた文末は丁寧に数えない", () => {
		expect(politenessScore("それはだめだよ。やめなよ。")).toBe(0);
		expect(politenessScore("そうなんだ。いいね！")).toBe(0);
	});

	it("混在は割合になる", () => {
		expect(politenessScore("そうですね。でも違うと思うよ。")).toBe(0.5);
	});

	it("引用・括弧内・コードは除外する", () => {
		expect(
			politenessScore("「なんだよ、ふざけんな」とおっしゃいましたね。"),
		).toBe(1);
		expect(stripQuoted("彼は『やめろよ』と言いました")).toBe(
			"彼はと言いました",
		);
		expect(
			politenessScore("`ls -la`を実行しましたが、結果はありません。"),
		).toBe(1);
	});

	it("語尾の記号・絵文字を無視する", () => {
		expect(politenessScore("楽しみです♪")).toBe(1);
		expect(politenessScore("よろしくお願いします…")).toBe(1);
	});

	it("挨拶など判定できない定型句は分母に入れない", () => {
		expect(politenessScore("こんにちは。")).toBe(1);
		expect(politenessScore("はい。それは違うよ。")).toBe(0);
	});

	it("空文字は 1", () => {
		expect(politenessScore("")).toBe(1);
	});
});

describe("endsWithQuestion", () => {
	it("疑問符と「か」終わりを検出する", () => {
		expect(endsWithQuestion("今日はどうでしたか？")).toBe(true);
		expect(endsWithQuestion("今日はどうでしたか。")).toBe(true);
		expect(endsWithQuestion("いかがでしょうか")).toBe(true);
		expect(endsWithQuestion("What do you think?")).toBe(true);
	});

	it("質問で終わらない文を除く", () => {
		expect(
			endsWithQuestion("お疲れさまでした。ゆっくり休んでくださいね。"),
		).toBe(false);
		expect(endsWithQuestion("")).toBe(false);
	});

	it("途中の質問は数えず、最後の文で見る", () => {
		expect(
			endsWithQuestion("何がありましたか？ 無理はなさらないでください。"),
		).toBe(false);
	});

	it("引用内の疑問符は数えない", () => {
		expect(endsWithQuestion("「本当に？」と思いました。")).toBe(false);
	});
});
