# @yunomi/worker

## 構成

- 設定は `cloudflare.config.ts` のみ。`cf` CLI が読む。`--mode production` で本番（Worker `yunomi`、`yunomi.chanu.co`）、省略または `development` で開発（`yunomi-dev`、`yunomi-dev.chanu.co`）に切り替わる。workers.dev と preview URL は無効。
- `cf dev` / `cf build` の委譲先は `wrangler`（この package の devDependency）。Vite は使わない。
- `ANTHROPIC_API_KEY` は `bindings.secret()` で宣言のみ。ローカルは `.dev.vars` に書く（未設定でも `/health` は動く）。
- `/health` は認証を要求しない（Cloudflare Access 側で bypass）。JWT 検証は別 Issue。
- Worker 名・ホスト・D1 database id は `resources.ts` に集約し、`cloudflare.config.ts` と `scripts/deploy.sh` が読む。`cf` の D1 database id は全ゼロ UUID を拒否するため、infra Issue (#7) で実 UUID に差し替えるまで `00000000-0000-4000-8000-000000000000` を置いている。

## 型

`pnpm typecheck` は `cf workers types`（`.cloudflare/types/index.d.ts` を生成、ネットワーク不要）の後に `tsc`。`cloudflare.config.ts` の `Env` とworkerd のランタイム型が入るため `@cloudflare/workers-types` は不要。`cloudflare.config.ts` は worker を名前で参照する DO binding の型を推論できないので、`src/index.ts` で `DurableObjectNamespace<PartnerDO>` に絞っている。

## テスト

`vitest.config.ts` が `cloudflare.config.ts` を `@cloudflare/config` の `loadAndParseConfig` + `convertToWranglerConfig` で読み、`.wrangler/test/wrangler.json` を生成して `@cloudflare/vitest-pool-workers` に渡す（Wrangler 設定の手書きは無い）。pool が必要とする DO の `migrations` を足し、secret / routes は落としている。D1 migration は `test/apply-migrations.ts` で適用する。`@cloudflare/config` は公式に unstable なので、破れたら miniflare binding のインライン指定に切り替える。

## D1 migration

`pnpm db:generate`（drizzle-kit、`migrations/NNNN_name.sql` のフラット配置は `cf d1 migrations apply` の既定 pattern `*.sql` と一致）。`pnpm db:migrate:local` はローカル Miniflare 状態へ適用する。

## デプロイ（dev）

`.github/workflows/deploy-dev.yml` が main への push と手動実行で dev に反映する。`pnpm turbo typecheck test` の後、`op run --env-file=.github/deploy/dev.env.op -- scripts/deploy.sh development` を実行する。

`scripts/deploy.sh <development|production>` の流れ:

1. `resources.ts` から D1 id を読む。プレースホルダのままなら、#7 を案内して失敗する。
2. `cf d1 migrations apply <id> --dir migrations`（remote）
3. `cf deploy --mode <mode>`。`ANTHROPIC_API_KEY` が環境にあれば `--secrets-file`（権限 600 の一時 `.env`、終了時に削除）で渡す。`cf workers secrets update` は `--text` しか持たず値が argv に載るため使わない。
4. `https://<host>/health` を最大 10 回（6 秒間隔）確認する。

#### 事前に人手で用意するもの

- GitHub Environment `dev` と、その secret `OP_SA_DEPLOY`（vault `yunomi-dev` を読む 1Password Service Account の token）
- 1Password vault `yunomi-dev` の item `cloudflare-api-token`（`credential`、`yunomi-deploy-dev` token）と `anthropic-api-key`（`credential`）。参照は `.github/deploy/dev.env.op`
- dev の D1 を作り、`resources.ts` の `development.d1Id` を実 UUID にする

#7 が終わるまで、このパイプラインは D1 id のガードで失敗する（`OP_SA_DEPLOY` 未設定でも 1Password 認証で失敗する）。

## デプロイ（prod）

`.github/workflows/deploy-prod.yml` は `workflow_dispatch` のみ（main への merge では動かない）。入力 `ref`（既定 `main`）は main か既存の tag に限り、それ以外は最初の step で失敗する。dev と同じ手順で `scripts/deploy.sh production` を実行する。

#### 事前に人手で用意するもの

- GitHub Environment `production`: Required reviewers を設定する（承認は GitHub の設定側で強制され、workflow には書けない）。secret `OP_SA_DEPLOY` は vault `yunomi-production` を読む別の 1Password Service Account の token
- 1Password vault `yunomi-production` の item `cloudflare-api-token`（`yunomi-deploy-prod` token）と `anthropic-api-key`。参照は `.github/deploy/production.env.op`
- prod の D1 を作り、`resources.ts` の `production.d1Id` を実 UUID にする

#### dev / prod 分離チェックリスト

- D1: `yunomi-dev` と `yunomi` で別 database（別 UUID）
- Worker / DO namespace: `yunomi-dev` と `yunomi`（DO は Worker 単位で分かれる）
- ホスト: `yunomi-dev.chanu.co` と `yunomi.chanu.co`
- Discord bot: 別アプリ・別 token（Gateway の `.env.dev` / `.env.prod`）
- Anthropic API key: 別 key（既定モデルは prod が Sonnet）
- Cloudflare Access: app・AUD・service token を別にする（`cloudflare.config.ts` の `ACCESS_AUD_*` / `ACCESS_CALLERS_*`）。dev の token で prod に入れない
- 1Password: vault `yunomi-dev` / `yunomi-production`、Service Account も別
- GitHub Environment: `dev`（承認なし）/ `production`（承認必須）
