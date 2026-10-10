# @yunomi/worker

## 構成

- 設定は `cloudflare.config.ts` のみ。`cf` CLI が読む。`--mode production` で本番（Worker `yunomi`、`yunomi.chanu.co`）、省略または `development` で開発（`yunomi-dev`、`yunomi-dev.chanu.co`）に切り替わる。workers.dev と preview URL は無効。
- `cf dev` / `cf build` の委譲先は `wrangler`（この package の devDependency）。Vite は使わない。
- `ANTHROPIC_API_KEY` は `bindings.secret()` で宣言のみ。ローカルは `.dev.vars` に書く（未設定でも `/health` は動く）。
- `/health` は認証を要求しない（Cloudflare Access 側で bypass）。JWT 検証は別 Issue。
- `cf` の D1 database id は全ゼロ UUID を拒否するため、infra Issue (#7) で実 UUID に差し替えるまで `00000000-0000-4000-8000-000000000000` を置いている。

## 型

`pnpm typecheck` は `cf workers types`（`.cloudflare/types/index.d.ts` を生成、ネットワーク不要）の後に `tsc`。`cloudflare.config.ts` の `Env` とworkerd のランタイム型が入るため `@cloudflare/workers-types` は不要。`cloudflare.config.ts` は worker を名前で参照する DO binding の型を推論できないので、`src/index.ts` で `DurableObjectNamespace<PartnerDO>` に絞っている。

## テスト

`vitest.config.ts` が `cloudflare.config.ts` を `@cloudflare/config` の `loadAndParseConfig` + `convertToWranglerConfig` で読み、`.wrangler/test/wrangler.json` を生成して `@cloudflare/vitest-pool-workers` に渡す（Wrangler 設定の手書きは無い）。pool が必要とする DO の `migrations` を足し、secret / routes は落としている。D1 migration は `test/apply-migrations.ts` で適用する。`@cloudflare/config` は公式に unstable なので、破れたら miniflare binding のインライン指定に切り替える。

## D1 migration

`pnpm db:generate`（drizzle-kit、`migrations/NNNN_name.sql` のフラット配置は `cf d1 migrations apply` の既定 pattern `*.sql` と一致）。`pnpm db:migrate:local` はローカル Miniflare 状態へ適用する。
