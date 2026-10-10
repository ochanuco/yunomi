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
- 今後追加: `apps/gateway` `apps/admin` `apps/cli` `partners/yukarin` `evals`

## コーディング規約

- Valibot は境界（外部入力、Envelope の検証）でのみ使う。内部の型は TypeScript の型で表す
- ドメインエラーは `type` で判別する discriminated union。例外を投げず `Result<T, E>` で返す
- ID は UUID v7（`newId()`）。時刻を漏らしたくない場合のみ `newOpaqueId()`
- D1 は Drizzle。migration は `drizzle-kit generate` で作り、手書きしない
- 時刻は内部 UTC、表示のみ JST
- コメントは日本語で、コードから読み取れない理由だけを書く
