# @yunomi/evals

Yukarin の人格を、決定的な検査と統計的な検査の二段で追跡する。

## シナリオ

`scenarios/*.yaml` に 1 ファイル 1 シナリオで書く（スキーマは `src/scenario.ts`）。
入力会話（直近ログと新着メッセージ、メンションの有無）、関係・状態のプリセット、持ちネタの cooldown 状態、期待する傾向を持つ。
期待は個々の出力の一致ではなく、複数サンプルで見る傾向として書く（返信率の範囲、丁寧語、質問終わりの割合の上限、Open Loop 抽出率・意見の shift 率・興味の up 率の範囲など）。

## Tier 1: PR（決定的・API 不要）

`pnpm turbo test` に含まれる。`pnpm --filter @yunomi/evals eval` または `pnpm turbo eval` は Tier 1 だけを走らせる。

- シナリオファイルの Valibot 検証、id の一意性、持ちネタ id の実在
- 全シナリオで `PromptBuilder` が組み上がり、ブロックの並び・見出しがスナップショットと一致する（本文は固定しない）
- 丁寧語ヒューリスティック `politenessScore` と `endsWithQuestion` の単体テスト
- 持ちネタ cooldown（`@yunomi/conversation` の `isJokeAvailable`）
- ターン応答スキーマの代表例
- Tier 2 ランナーの結果（集計、信頼区間、違反判定、終了コード）を `FakeLLMProvider` で検証する。provider は注入されるので、テストは通信しない

## Tier 2: nightly・手動（実 API）

```sh
ANTHROPIC_API_KEY=... pnpm --filter @yunomi/evals eval:tier2 -- --samples 5 --env development
```

| オプション | 既定 | 内容 |
| --- | --- | --- |
| `--samples` | 5 | シナリオごとのサンプル数 |
| `--env` | development | プロファイルの環境。応答は dev / prod とも Sonnet で生成する |
| `--scenario <id>` | 全件 | 対象を絞る（複数指定可） |
| `--strict` | なし | 閾値違反があるとき終了コード 1 |

応答は `ModelRouter` 経由で生成し、judge は Sonnet（`claude-sonnet-5-5`）で構造化出力を得る。
結果は `evals/out/tier2-<timestamp>.json`（gitignore 済み）に書き、要約表を標準出力に出す。
`.github/workflows/eval-nightly.yml` が毎日 18:00 UTC に実行し、JSON を artifact として残す。

### 指標

| 指標 | 算出 |
| --- | --- |
| `reply_rate` | `reply_policy` が `reply` の割合 |
| `politeness_score` | 返信の丁寧語尾の文の割合（ヒューリスティック）。平均・分散・標準偏差 |
| `question_ending_rate` | 返信のうち文末が質問のもの |
| `persona_consistency` | judge が 0〜1 で採点。平均・標準偏差 |
| `over_agreement_rate` | judge が迎合しすぎと判定した割合 |
| `fanon_overuse_rate` | judge が二次設定の出しすぎと判定した割合 |
| `claims_unperformed_action_rate` | judge が未実行の行動を実行したと述べていると判定した割合 |
| `invented_facts_rate` | judge が設定にない事実を作っていると判定した割合 |
| `meta_talk_rate` | judge がメタな発言（人格設定の中身や決まり方の説明）と判定した割合 |
| `cooling_down_joke_rate` | cooldown 中の持ちネタを使った割合 |
| `open_loop_rate` | 返信のうち `open_loops` を 1 件以上返した割合。黙ったサンプルは分母に入れない |
| `memory_candidate_rate` | 返信のうち `memory_candidates` を 1 件以上返した割合。黙ったサンプルは分母に入れない |
| `opinion_shift_rate` | 返信のうち、プロファイルにある topic の `opinion_signals` に `shift` を含めた割合。黙ったサンプルは分母に入れない |
| `interest_up_rate` | 返信のうち、プロファイルにある topic の `interest_signals` に `up` を含めた割合。黙ったサンプルは分母に入れない |

率は Wilson 95% 区間を併記する。

### 判定

LLM の出力は確率的であり、ばらつきそのものは失敗ではない。完全一致ではなく閾値と信頼区間で判定する。

- 率の指標は、Wilson 区間全体が許容範囲の外にあるときだけ違反にする。サンプルが少ないときの偶然のぶれは違反にならない。
- `reply_rate` と `open_loop_rate` / `memory_candidate_rate` / `opinion_shift_rate` / `interest_up_rate`（シナリオが期待を書いたときだけ）は期待範囲の min / max の両側、他の率は上限（`over_agreement_rate` は 0.2、`fanon_overuse_rate` は 0.3、`meta_talk_rate` は 0.2、未実行の行動・作り話・cooldown 違反は 0、質問終わりはシナリオの `question_ending_rate_max`）を見る。
- `politeness_score` と `persona_consistency` は平均が下限を下回ったとき違反にする。
- 生成や judge の失敗は違反ではなく、`generation_errors` と各サンプルの `judge_error` に記録する。全サンプルが失敗したシナリオは違反にする。

終了コードは、`--strict` で違反があるときだけ 1、引数や認証の誤りは 2、それ以外は 0。
