# @yunomi/worker

## 構成

- 設定は `cloudflare.config.ts` のみ。`cf` CLI が読む。`--mode production` で本番（Worker `yunomi`、`yunomi.chanu.co`）、省略または `development` で開発（`yunomi-dev`、`yunomi-dev.chanu.co`）、`--mode local` でローカル専用（`yunomi-local`、ドメインなし）に切り替わる。local は deploy しない。workers.dev と preview URL は無効。
- `cf dev` / `cf build` の委譲先は `wrangler`（この package の devDependency）。Vite は使わない。
- `ANTHROPIC_API_KEY` は `bindings.secret()` で宣言のみ。ローカルは `.dev.vars` に書く（未設定でも `/health` は動く）。
- `/health` は認証を要求しない（Cloudflare Access 側で bypass）。それ以外は `src/auth/access.ts` が `Cf-Access-Jwt-Assertion`（RS256）を `ACCESS_TEAM_DOMAIN` の JWKS・`ACCESS_AUD`・issuer で検証する。`email` が `OWNER_EMAILS` にあれば owner、service token は `common_name` を `ACCESS_CALLERS` で `gateway` / `ykm` に引く。`POST /v1/interfaces/discord/events` は `gateway` のみ。
- ローカル開発の迂回: `ALLOW_DEV_CALLER=1` のとき、ヘッダ `x-yunomi-dev-caller: gateway|ykm` でその呼び出し元として扱う。`ALLOW_DEV_CALLER` は `--mode local` だけが `"1"` にし、development / production は `"0"`。`pnpm --filter @yunomi/worker dev` は `cf dev --mode local`。`cf dev` はカスタムドメインがあると request.url を書き換えるため、host では判定しない。
- `cf` の D1 database id は全ゼロ UUID を拒否するため、infra Issue (#7) で実 UUID に差し替えるまで `00000000-0000-4000-8000-000000000000` を置いている。

## 型

`pnpm typecheck` は `cf workers types`（`.cloudflare/types/index.d.ts` を生成、ネットワーク不要）の後に `tsc`。`cloudflare.config.ts` の `Env` とworkerd のランタイム型が入るため `@cloudflare/workers-types` は不要。`cloudflare.config.ts` は worker を名前で参照する DO binding の型を推論できないので、`src/index.ts` で `DurableObjectNamespace<PartnerDO>` に絞っている。

## テスト

`vitest.config.ts` が `cloudflare.config.ts` を `@cloudflare/config` の `loadAndParseConfig` + `convertToWranglerConfig` で読み、`.wrangler/test/wrangler.json` を生成して `@cloudflare/vitest-pool-workers` に渡す（Wrangler 設定の手書きは無い）。pool が必要とする DO の `migrations` を足し、secret / routes は落としている。D1 migration は `test/apply-migrations.ts` で適用する。`@cloudflare/config` は公式に unstable なので、破れたら miniflare binding のインライン指定に切り替える。

## D1 migration

`pnpm db:generate`（drizzle-kit、`migrations/NNNN_name.sql` のフラット配置は `cf d1 migrations apply` の既定 pattern `*.sql` と一致）。`pnpm db:migrate:local` はローカル Miniflare 状態へ適用する。

## Partner DO

`PartnerDO`（`idFromName(partner_id)`）が会話状態を持つ。DO SQLite のテーブルは `src/do/schema.ts` の versioned migration でコンストラクタ内に作る。`handleDiscordMessage` は dedupe（`processed_events`、7 日）、チャンネル単位の直列化（処理中に届いた発言は `recent_messages` に積み、完了後に最新 1 件だけ再判定、古い待機は `coalesced` で ignore）、`pipeline` の呼び出しを行う。`pipeline` と `now` はテストが `runInDurableObject` で差し替える seam。

## State / Relationship

純粋なドメイン関数は `@yunomi/core` の `partner-state.ts`（`applyStateDelta` / `applyRelationshipDelta`、日次上限は `lifestyleDay` の JST 05:00 境界）。現在値は DO SQLite（`partner_state`、`relationships`）、履歴は D1（`state_transitions`、`relationship_events`）。D1 の履歴書き込みは `ctx.waitUntil` に載せて応答を待たせない。テストは `PartnerDO.flushBackground()` で完了を待つ。作者の entity 解決（`entities` / `external_identities`）は LLM 判定に進んだときに行う。

## Memory

LLM の `memory_candidates` は D1 の `memory_candidates` に保存し、`decidePromotion`（`@yunomi/core`）の決定的な規則で `facts` に昇格する。話者を指す subject（`user` / `speaker` / 表示名 / Discord user id）以外は entity を解決できないため `pending` のまま `subject_text` に原文を残す。prompt には話者の現行 Fact を importance 降順・observed_at 降順で上位 12 件入れる。書き込みは次のターンが読めるよう応答前に完了させる。

## Audit

1 メッセージにつき `audit_events`（D1）へ 1 行を書く。自己発言は書かない。書き込みは `#background`（`ctx.waitUntil`）に載せ、`flushBackground()` が待つ。思考過程は持たず、判断サマリ・モデル・fallback・token・latency・受信本文と、state / relationship / memory / tool_intents の詳細（`detail_json`）だけを残す。`created_at` が `AUDIT_RETENTION_DAYS`（30）より古い行は、毎日 04:17 JST（`17 19 * * *` UTC）の `scheduled` が削除する。

## Admin API

`/admin/api/partners/:partnerId/{status,relationships,memory,audit}` は読み取り専用。owner と `ykm` だけが使える（`gateway` は 403、JWT なしや不正は 401）。`memory` は `kind=facts|candidates`、`audit` は新しい順で `since` を取れる。一覧は `limit`（既定 50、最大 200）と、`created_at` と `id` から作る base64url の不透明な `cursor` でたどる。応答の型とスキーマは `@yunomi/admin-contract`。state と relationship の現在値は DO、それ以外は D1 から返す。

## Admin Web の配信

`/admin/` 配下は `apps/admin` のビルド成果物を返す。`cloudflare.config.ts` の `assets` が配信ディレクトリを指定できないため、`scripts/embed-admin.ts` が `../admin/dist` を `src/generated/admin-assets.ts`（git 管理外）に埋め込み、`src/admin/static.ts` が返す。`typecheck` / `test` は未ビルドなら空で生成し、`build` は `dist` が無いと失敗する。詳細は `apps/admin/README.md`。
