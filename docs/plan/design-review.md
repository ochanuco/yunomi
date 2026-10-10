# 設計レビュー

対象: `docs/design/` 一式（2026-10-10 版）。プロダクトの思想には手を入れず、実装に入る前に決めておかないと手戻りになる点だけを扱う。

## Blockers

実装開始前に決める必要があるもの。各項目に推奨案を併記し、この計画では推奨案を採用して進める。

### B1. Home Gateway ↔ Yunomi の転送方式と返信経路

`architecture.md` は「HTTPS / WebSocket」としか書いておらず、返信を誰が Discord に送るかが未定義。

推奨:

- MVP は Gateway → Yunomi の同期 HTTPS リクエスト/レスポンスにする。Gateway は `POST /v1/interfaces/discord/events` を呼び、レスポンスとして `reply`（本文付き）か `ignore` を受け取る。Discord への送信は Gateway が行う。
- Discord bot token は Home にだけ置く。Worker は token を持たない。
- LLM 待ちの間、Gateway は typing indicator を出す。Workers の HTTP リクエストは接続中なら wall time 制限がないため、Sonnet の応答待ち（数秒〜数十秒）でも成立する。
- 自発発言（Phase 2）では Gateway から Yunomi へ outbound WebSocket（Partner DO の Hibernatable WebSocket）を張り、DO から push する。Home が落ちていれば Discord は使えない、という前提（`discord.md`）とも矛盾しない。

### B2. Partner DO 内の並行性

DO は単一スレッドだが、`fetch`（Claude 呼び出し）の await 中に別のリクエストが割り込む。1 回の LLM 呼び出しは数秒かかるため、同じチャンネルへの連投や複数チャンネルの同時発話で次の問題が出る。

- 同じチャンネルで同じ文脈を元に二重返信する
- State/Relationship の更新が後勝ちで消える

推奨:

- チャンネル単位で処理を直列化する。処理中に届いたメッセージは recent context に積むだけにし、処理完了後にまとめて 1 回だけ再判定する（coalesce）。
- State/Relationship は LLM が返した delta を、応答確定時点の最新 state に対して bounded に適用する。LLM に絶対値を返させない。delta 適用は同期コードで行い、await を挟まない。

### B3. Relationship の主体キー

`domain-model.md` の Relationship State は「誰との関係か」を持っていない。また `mvp-scope.md` では familiarity/trust が State 側に並んでいる。

推奨:

- Relationship は `(partner_id, entity_id)` をキーにする。entity は UUID v7 の内部 ID を持ち、Discord user id は `external_identities` テーブルで対応付ける。
- familiarity / trust は Relationship の次元として扱う。Partner State は mood / energy / presence / system_stress / degraded_mode に限る。
- MVP はサーバー内の全人間ユーザーに Relationship を作るが、更新幅の上限は同じにする。

### B4. Memory candidate から Fact への昇格

MVP Done 条件の「Minimal facts survive restarts」は、候補を保存するだけでは満たせない。

推奨:

- `memory_candidates` と `facts` を分ける。
- MVP の昇格ルールは決定的にする。本人による明示的な自己申告（source=`user_statement`）で confidence ≥ 0.8 のものは自動で Fact にする。それ以外は candidate のまま残す。
- 既存 Fact と subject+predicate が衝突し、内容が異なる場合は自動置換せず、candidate に `conflict_target` を付けて残す（`memory.md` の Contradictions 方針の最小版）。
- Prompt には importance と recency で選んだ上位 N 件の Fact を入れる（意味検索はしない）。

### B5. `cf` CLI の成熟度と設定の分担

`cf`（`cf@1.0.0-beta.14`）は 2026-10 時点で beta で、`cf/config` の実体（`@cloudflare/config`）は自身を「外部利用にはまだ安定していない」としている。また次の 2 点は `cloudflare.config.ts` で表現できない。

- D1 migration の置き場所（`cf d1 migrations apply` は DB の UUID と `--dir` を受け取る）
- `@cloudflare/vitest-pool-workers` の設定（Wrangler 設定を読む）

`cf init` の雛形は Vite を使うが、Vite は必須ではない。`cf dev` / `cf build` は `package.json` に宣言された実装（`@cloudflare/vite-plugin` か `wrangler`）に委譲する。

推奨: `cf` の版を固定し、Worker のビルド実装には `wrangler` を使う。これで「main Worker は Vite 不要」を守れる。D1 migration は `drizzle-kit` の生成物を `cf d1 migrations apply` で適用し、テスト用の Wrangler 設定は `cloudflare.config.ts` から生成する（詳細は `docs/plan/cf-cli.md`）。

### B6. CI/CD の「chabatake と同じ運用」が実態と異なる

`decisions.md` は「PR: test/typecheck/eval, main: dev deploy, prod: manual」を chabatake と同じ運用としているが、chabatake の実態は「PR で plan → main への push で release PR を自動作成 → `production` ブランチへの merge で apply」で、secret は 1Password Service Account（`op run`）経由で注入している。

推奨: デプロイ段階は設計どおり（PR 検証 / main→dev / prod は手動）にし、仕組みは chabatake に合わせる。

- prod は `production` ブランチへの release PR の merge、または `workflow_dispatch` を GitHub Environment `production` で保護する。
- Cloudflare API token などの secret は 1Password Service Account から `op run` で注入する。
- Actions は SHA pin、`permissions: contents: read`、`persist-credentials: false`。

## 推奨修正（Blocker ではないが最初の縦切りに入れる）

| # | 対象 | 修正内容 |
| --- | --- | --- |
| C1 | Discord Message Content Intent | 非メンションの継続会話を読むには privileged intent が必要。dev/prod 両方の bot application で有効化する（100 サーバー未満なので審査は不要）。 |
| C2 | 重複受信 | Gateway の再送に備え、`source=discord` + Discord message id で DO 内 dedupe（`events.md` の Dedupe 方針）。 |
| C3 | 返信長 | Discord の 2000 文字制限に合わせ、structured output の utterance に上限を設けて Gateway 側で分割しない。 |
| C4 | 構造化出力の失敗 | スキーマ不一致・パース失敗は `ignore` + `degraded` として Audit に残し、ユーザーには何も送らない。主モデルは dev / prod とも Sonnet で、失敗時は Haiku で 1 回だけ再試行する。 |
| C5 | Audit の保持期間 | `observability.md` は短期保存とするが期限がない。D1 には TTL がないので、受信本文を含む詳細 Audit は 30 日で Cron が削除する。判断サマリだけの KPI 集計は残す。 |
| C6 | Queue の導入時期 | 最初の縦切りでは非同期処理がない（memory candidate は同じ structured output から同期で保存できる）。EventBus interface と Envelope は最初に定義し、Cloudflare Queues 実装は最初の非同期 consumer（Goal 2 の memory extraction / summary）で入れる。Audit 書き込みは `ctx.waitUntil` 相当で応答経路から外す。 |
| C7 | Open Loop | `mvp-scope.md` は MVP で抽出・保存とするが、`CLAUDE_TASK.md` の最初の縦切りと `implementation-plan.md` は Goal 2。structured output のスキーマには `open_loop_updates` を入れ、保存は Goal 2 で行う。 |
| C8 | 公開リポジトリ | `ochanuco/yunomi` は public。snapshot・prod 由来の seed・会話ログ・eval の実データはリポジトリに置かない。persona の公式設定は要約・言い換えで書き、公式文章の転載はしない。 |
| C9 | 他ユーザーからの指示注入 | サーバー内の他人の発言が prompt に入る。MVP はツール実行がないため影響は発話内容に限られるが、`tool_intents` は MVP では無視して Audit に記録だけする。 |
| C10 | Admin / Gateway / ykm の認証 | Admin は Cloudflare Access（owner のみ）。Gateway と `ykm` は Access Service Token。Worker 側でも `Cf-Access-Jwt-Assertion` を検証し、Access を経由しない `workers.dev` 経路は無効化する。Access app と service token は chabatake 側の `app_yunomi.tf` で作る（chabatake の `app_utsuroi.tf` と同じ分担）。 |

## 安全に先送りできる決定

- Vectorize のインデックス設計、embedding モデル、rerank の重み
- Episode 圧縮、daily summary、partner journal、lifestyle-day 境界の実装（MVP は UTC 保存 + JST 表示のみ）
- Snapshot の暗号化方式と第 2 保存先（Home / GCP）
- 予算ポリシーの閾値（70/85/95%）と Analytics Engine の指標設計。最初の縦切りでは Audit に token 数を残すだけにする
- チャンネル別ポリシー、DM、staging 環境
- 自発発言のパラメータ（initiative など）。B1 の WebSocket 経路だけ将来の拡張点として残す
- capability / MCP の permission モデル（auto/confirm/deny）。MVP はツールを実行しない
- Voice / STT / A.I.VOICE / VC 全般
- Admin の SSE。MVP はポーリング

## 過剰な抽象化の指摘

- `packages/` の細分化（partner-core / memory / relationship …）は最初からやらない。`repo-layout.md` の「小さく始める」案（`apps/worker`, `apps/admin`, `packages/core`）に `apps/gateway` と `apps/cli` を足した構成で始める。
- `VectorStore` / `BlobStore` interface は使う実装ができるまで作らない。`EventBus` と `LLMProvider` だけ最初から作る（後者は fallback と fake を差し替えるのに既に必要）。
