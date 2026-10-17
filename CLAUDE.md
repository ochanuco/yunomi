# yunomi リポジトリ規約

計画の一次情報は `docs/plan/`。実装前に該当する Epic / Issue を確認する。

## コマンド

- `pnpm install`
- `pnpm turbo typecheck lint test`: PR 前に必ず通す
- `pnpm turbo build` / `pnpm turbo eval`
- `pnpm format`: Biome で整形（lint も Biome）
- 個別パッケージ: `pnpm --filter @yunomi/worker <script>`

## 構成

- `apps/worker`: Cloudflare Worker（`cf` CLI + `cloudflare.config.ts`、Wrangler を委譲先に使う。Vite は使わない）
- `packages/core`: `@yunomi/core`。ID、ドメインエラー、Envelope、EventBus。Workers 型に依存しない
- `packages/capabilities`: `@yunomi/capabilities`。道具の契約、道具の定義、policy の判定、adapter。Workers 型に依存せず、`packages/llm` とは互いに import しない
- `packages/admin-contract`: `@yunomi/admin-contract`。Admin 読み取り API（`/admin/api/...`）の応答型と Valibot スキーマ。Worker・`ykm`・Admin Web が共有する
- `apps/cli`: `@yunomi/cli`（bin `ykm`）。Admin API を読む CLI。ビルドせず Node 24 の type stripping で `src/bin.ts` を実行する
- `apps/admin`: `@yunomi/admin`。Admin Web（Vite + plain DOM）。ビルド成果物は `apps/worker/scripts/embed-admin.ts` で Worker に埋め込み、`/admin/` で配信する
- `apps/gateway`: Home の Discord Gateway（discord.js、`tsx` で直接実行）
- `partners/yukarin`: `@yunomi/partner-yukarin`。Yukarin の人格本文とプロファイル
- `evals`: `@yunomi/evals`。persona eval（Tier 1 は `pnpm turbo test`、Tier 2 は `pnpm turbo eval`）

## コーディング規約

- Valibot は境界（外部入力、Envelope の検証）でのみ使う。内部の型は TypeScript の型で表す
- ドメインエラーは `type` で判別する discriminated union。例外を投げず `Result<T, E>` で返す
- ID は UUID v7（`newId()`）。時刻を漏らしたくない場合のみ `newOpaqueId()`
- D1 は Drizzle。migration は `drizzle-kit generate` で作り、手書きしない
- 時刻は内部 UTC、表示のみ JST
- コメントは日本語で、コードから読み取れない理由だけを書く
