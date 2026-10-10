# @yunomi/admin

Yukarin の State / Memory / Audit を見る Admin Web。Vite + TypeScript + plain DOM（フレームワークなし）。読み取り専用で、`/admin/api/` の応答は `@yunomi/admin-contract` のスキーマで検証する。

| ハッシュ | 内容 |
| --- | --- |
| `#/state` | State、件数、Relationship |
| `#/memory` | Facts / Candidates のタブ（`?kind=candidates`） |
| `#/audit` | 新しい順の一覧。行を選ぶと詳細ドロワー（`?id=`、Esc で閉じる） |

表示中の画面だけを 10 秒ごとに取り直す。一覧は先頭ページを取り直して既読分へ id で混ぜるので、「古いものを読み込む」で足した行は消えない。API 由来の文字列は `textContent` / text node でだけ描画し（`src/dom.ts`）、`innerHTML` は使わない。

## ローカル

```
pnpm --filter @yunomi/worker exec wrangler dev -c .wrangler/test/wrangler.json --port 8788   # Worker
ADMIN_API_TARGET=http://localhost:8788 pnpm --filter @yunomi/admin dev                        # http://localhost:5173/admin/
```

Vite の proxy が `/admin/api` を Worker へ転送し、`x-yunomi-dev-caller: ykm` を付ける（Access の代わり）。`ADMIN_API_TARGET` の既定は `http://localhost:8787`。`cf dev` はカスタムドメインの route があると request の host を書き換えて localhost 判定が効かないため、route を持たない `.wrangler/test/wrangler.json`（`pnpm --filter @yunomi/worker test` で生成）を使う。

## Worker からの配信

`cloudflare.config.ts` の `assets` は配信ディレクトリを指定できない（`htmlHandling` / `runWorkerFirst` 等のみ）。このため `assets` は使わず、`apps/worker/scripts/embed-admin.ts` が `apps/admin/dist` を `apps/worker/src/generated/admin-assets.ts`（git 管理外）へ埋め込み、Worker が `/admin/` 配下で返す（`src/admin/static.ts`）。`/admin/api/*` は先に API ハンドラへ振られる。

- `@yunomi/worker` は `@yunomi/admin` に依存するので、turbo の `^build` が admin を先に作る。
- Worker の `typecheck` / `test` は未ビルドでも空の埋め込みで動く。`build` は `dist` が無いと失敗する。
- HTML と JS/CSS は認証なしで返る（機密を含まない）。データは `/admin/api/` が owner / `ykm` に限って返す。ホスト全体は Access が保護する。
