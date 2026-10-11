# `cf` CLI の採用方針

対象: `cf@1.0.0-beta.14`（`cf/config` は `@cloudflare/config/public` の再エクスポート）。beta のため、版を固定して使う。

## 使い方の前提

| 項目 | 方針 |
| --- | --- |
| 設定 | `apps/worker/cloudflare.config.ts` 1 本。`cf` は cwd から上へ最も近い `cloudflare.config.ts` を探すため、コマンドは `apps/worker` で実行する。 |
| ビルド実装 | `cf dev` / `cf build` は `package.json` に宣言された実装（`@cloudflare/vite-plugin` v2 か `wrangler >=4.136`）にちょうど 1 つ委譲する。Worker は `wrangler` を委譲先にし、Vite を持ち込まない。委譲先は `apps/worker` 自身の依存に置く（root だけに置くと検出されない）。 |
| dev / prod / local | `--mode development` / `--mode production` / `--mode local`。local はカスタムドメインを付けず、`ALLOW_DEV_CALLER` を有効にする（`cf dev` はカスタムドメインがあると `request.url` をそのホストに書き換えるため）。`defineConfig(({ mode }) => ...)` で Worker 名と D1 の id を切り替える。環境別の設定ファイルは作らない。 |
| DO | `exports: { PartnerDO: exports.durableObject({ storage: "sqlite" }) }` と `bindings.durableObject({ exportName: "PartnerDO" })`。migration tag はなく、クラスの状態を宣言する。 |
| D1 migration | `cloudflare.config.ts` では表現できない。`drizzle-kit` で `apps/worker/migrations/*.sql` を生成し、リモートは `cf d1 migrations apply <database-uuid>`（名前ではなく UUID を渡す）で適用する。`--local` は `cf dev` と別の state を見て確認待ちで止まるため、ローカルは `wrangler d1 migrations apply --local --persist-to .wrangler/state` で適用する（`pnpm db:migrate:local`）。 |
| secret | 名前を `bindings.secret()` で宣言する。デプロイ時は `cf deploy --secrets-file`（.env 形式の一時ファイル）で渡す。`cf workers secrets update` は値を `--text` でしか受け取らず argv に残るため使わない。ローカルは `.dev.vars.<mode>`。 |
| R2 | `SNAPSHOTS: bindings.r2({ name: "<bucket>" })`。`name` が bucket 名で、binding 名（`SNAPSHOTS`）とは別。bucket は `cf` では作られないので事前に作る。bucket 名は `resources.ts` に mode ごとに置く。vitest では local mode の設定から生成した wrangler.json の `r2_buckets` を Miniflare がそのまま扱うため、追加の設定は要らない。 |
| 静的アセット | `bindings.assets` は `directory` を指定できず `cf build` が失敗する。Admin Web のビルド成果物は `scripts/embed-admin.ts` で Worker に埋め込んで配信する。 |
| 型 | `cf workers types` はオフラインで動く。`cf-worker` の import attribute のため `tsconfig` は `module: preserve` にする。 |
| テスト | `@cloudflare/vitest-plugin` は Wrangler 設定しか読まない。`vitest.config.ts` で `loadAndParseConfig` と `convertToWranglerConfig`（`@cloudflare/config`）を使い、local mode の設定から `.wrangler/test/wrangler.json` を生成して渡す。`exports` は plugin が解釈しないため、DO クラスは `migrations` の `new_sqlite_classes` として補う。 |

## Wrangler を併用する条件

`cf` で表現できない設定が必要になったときだけ。現時点で必要な binding（DO、D1、Queues の producer/consumer、Workflows、R2、Vectorize、Analytics Engine、Cron、カスタムドメイン）はすべて `cf/config` にある。
