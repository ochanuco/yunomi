# `cf` CLI の採用方針

対象: `cf@1.0.0-beta.14`（`cf/config` は `@cloudflare/config/public` の再エクスポート）。beta のため、版を固定して使う。

## 使い方の前提

| 項目 | 方針 |
| --- | --- |
| 設定 | `apps/worker/cloudflare.config.ts` 1 本。`cf` は cwd から上へ最も近い `cloudflare.config.ts` を探すため、コマンドは `apps/worker` で実行する。 |
| ビルド実装 | `cf dev` / `cf build` は `package.json` に宣言された実装（`@cloudflare/vite-plugin` v2 か `wrangler >=4.136`）にちょうど 1 つ委譲する。Worker は `wrangler` を委譲先にし、Vite を持ち込まない。委譲先は `apps/worker` 自身の依存に置く（root だけに置くと検出されない）。 |
| dev / prod | `--mode development` / `--mode production`。`defineConfig(({ mode }) => ...)` で Worker 名と D1 の id を切り替える。環境別の設定ファイルは作らない。 |
| DO | `exports: { PartnerDO: exports.durableObject({ storage: "sqlite" }) }` と `bindings.durableObject({ exportName: "PartnerDO" })`。migration tag はなく、クラスの状態を宣言する。 |
| D1 migration | `cloudflare.config.ts` では表現できない。`drizzle-kit` で `apps/worker/migrations/*.sql` を生成し、`cf d1 migrations apply <database-uuid> [--local]` で適用する（名前ではなく UUID を渡す）。 |
| secret | 名前を `bindings.secret()` で宣言し、値は `cf workers secrets update <name> --worker <script> --text ...` で入れる。ローカルは `.dev.vars.<mode>`。 |
| テスト | `@cloudflare/vitest-pool-workers` は Wrangler 設定を読む。`cloudflare.config.ts` から `convertToWranglerConfig`（`@cloudflare/config`）でテスト用の Wrangler 設定を生成するか、それが動かなければ miniflare の binding をインラインで渡す。どちらにしたかは Y03 の PR で決めてここに追記する。 |

## Wrangler を併用する条件

`cf` で表現できない設定が必要になったときだけ。現時点で必要な binding（DO、D1、Queues の producer/consumer、Workflows、R2、Vectorize、Analytics Engine、Cron、カスタムドメイン）はすべて `cf/config` にある。
