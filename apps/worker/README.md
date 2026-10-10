# @yunomi/worker

## 構成

- 設定は `cloudflare.config.ts` のみ。`cf` CLI が読む。`--mode production` で本番（Worker `yunomi`、`yunomi.chanu.co`）、省略または `development` で開発（`yunomi-dev`、`yunomi-dev.chanu.co`）に切り替わる。workers.dev と preview URL は無効。
- `cf dev` / `cf build` の委譲先は `wrangler`（この package の devDependency）。Vite は使わない。
- `ANTHROPIC_API_KEY` は `bindings.secret()` で宣言のみ。ローカルは `.dev.vars` に書く（未設定でも `/health` は動く）。
- `/health` は認証を要求しない（Cloudflare Access 側で bypass）。それ以外は `src/auth/access.ts` が `Cf-Access-Jwt-Assertion`（RS256）を `ACCESS_TEAM_DOMAIN` の JWKS・`ACCESS_AUD`・issuer で検証する。`email` が `OWNER_EMAILS` にあれば owner、service token は `common_name` を `ACCESS_CALLERS` で `gateway` / `ykm` に引く。`POST /v1/interfaces/discord/events` は `gateway` のみ。
- ローカル開発の迂回: `YUNOMI_ENV=development` かつ request の host が `localhost` / `127.0.0.1` のとき、ヘッダ `x-yunomi-dev-caller: gateway|ykm` でその呼び出し元として扱う。カスタムドメイン宛てや production では効かない。
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
