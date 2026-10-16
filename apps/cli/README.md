# @yunomi/cli (`ykm`)

Admin API（`/admin/api/...`）を叩いて、Yukarin の状態・記憶・判断履歴をターミナルで見て、Partner Snapshot を扱う。

```
ykm status                                   State / Relationship / 件数
ykm memory list [--candidates] [--all] [--limit N]   Fact（既定）か candidate の一覧。Fact は現行だけで、--all で置き換え済み・期限切れも含める
ykm open-loops [--all] [--limit N]           未解決の話題（Open Loop）の一覧。既定は open だけで、--all で resolved / dropped も含める
ykm interests                                現在の Interest（score の降順）。行の無い topic はプロファイルの初期値（source: profile）
ykm opinions                                 現在の Opinion（stance・confidence・stability）
ykm kpi [--days N]                          生活日ごとの KPI（既定 30 日、当日は含まない）
ykm audit tail [-n N] [-f]                   直近の audit。-f は 5 秒ごとに since で追う
ykm snapshot list                            Snapshot の一覧（id、作成時刻、size、schema_version、env）
ykm snapshot create                          Snapshot を今すぐ作成
ykm snapshot pull <id> -o <file>             暗号化のまま保存
ykm snapshot seed <id> --from prod --to dev  prod の Snapshot を dev に流し込む
```

共通オプション: `--env dev|prod`（既定 dev）、`--url`、`--partner`（既定 `yukarin`）、`--json`。`--json` は整形せず JSON を出す（`status` は `{status, relationships}`、`open-loops` は応答（`{items, next_cursor}`）、`interests` / `opinions` は応答（`{items}`）そのまま、`audit tail` は 1 行 1 件）。人間向けの出力は表で、時刻は JST。

## 接続先と認証

| 項目 | 指定 |
| --- | --- |
| URL | `--url` > `YKM_DEV_URL` / `YKM_PROD_URL`。どちらも無ければ設定エラー |
| 認証 | `YKM_DEV_ACCESS_CLIENT_ID` / `YKM_DEV_ACCESS_CLIENT_SECRET`（prod は `YKM_PROD_...`）を `CF-Access-Client-Id` / `CF-Access-Client-Secret` で送る。env 別の指定が無ければ `YKM_ACCESS_CLIENT_ID` / `YKM_ACCESS_CLIENT_SECRET` を使う |
| ローカル | URL が `localhost` / `127.0.0.1` で token が無いときは `x-yunomi-dev-caller: ykm` を送る |

接続先と token は `op run` の env ファイルにまとめておくと、毎回指定せずに済む。URL は secret ではないのでそのまま書く。

```
YKM_DEV_URL=https://<dev host>
YKM_PROD_URL=https://<prod host>
YKM_DEV_ACCESS_CLIENT_ID=op://<vault>/<item>/client_id
YKM_DEV_ACCESS_CLIENT_SECRET=op://<vault>/<item>/client_secret
```

```
op run --env-file <env ファイル> -- pnpm --filter @yunomi/cli ykm status
```

応答は `@yunomi/admin-contract` のスキーマで検証する。契約に合わなければエラーにする。終了コードは 0（成功）、1（接続・認証・設定の失敗）、2（使い方の誤り）。

## ビルドと実行

ビルドしない。Node 24 の type stripping で `src/bin.ts` を直接実行する（bin も `./src/bin.ts`）。ワークスペース依存の `@yunomi/admin-contract` も TS ソースを export しているため、tsc の出力や tsx は要らない。そのため `erasableSyntaxOnly`（enum や parameter property を使わない）を有効にしている。

```
pnpm --filter @yunomi/cli ykm status --url http://localhost:8787
```

ローカルの Worker は `pnpm --filter @yunomi/worker dev`（`cf dev --mode local`）で立てる。この mode だけが `x-yunomi-dev-caller` を信用する。

## Snapshot

`snapshot list` / `create` / `pull` は共通オプションの `--env`（既定 dev）の Worker に対して動く。`pull` は R2 の暗号化済み blob をそのまま `-o` に保存する。

#### seed

```
YKM_AGE_IDENTITY=op://Personal/yunomi-prod-snapshot-age/credential \
YKM_PROD_ACCESS_CLIENT_ID=op://Personal/yunomi-ykm/client_id \
YKM_PROD_ACCESS_CLIENT_SECRET=op://Personal/yunomi-ykm/client_secret \
YKM_DEV_ACCESS_CLIENT_ID=op://Personal/yunomi-dev-ykm/client_id \
YKM_DEV_ACCESS_CLIENT_SECRET=op://Personal/yunomi-dev-ykm/client_secret \
  op run -- ykm snapshot seed <id> --from prod --to dev
```

1. `--from` の env から暗号化済み Snapshot を取得する
2. 手元で `YKM_AGE_IDENTITY`（age の秘密鍵文字列）で復号し、gzip を展開して `SnapshotSchema` で検証する
3. `--to` の `POST /admin/api/partners/:partnerId/snapshots/restore` に送る

復号した平文はメモリの上だけで扱い、ディスクに書かない。`--to` は `dev` だけで、`prod` は CLI でも拒否する（Worker も production の restore を 403 にする）。`--url` は使えず、接続先は `YKM_DEV_URL` / `YKM_PROD_URL` で決まる。`--from` と `--to` にはそれぞれの env の service token（`YKM_PROD_ACCESS_*` / `YKM_DEV_ACCESS_*`）を送る。

## 未実装の変更系コマンド

実装時は Admin API に書き込み系の endpoint と別の認可（owner の操作として audit に残す）を足す。

- `ykm memory delete <fact-id>`: Fact を `valid_to` で失効させる（行は消さず、履歴に残す）。
- `ykm memory candidates review <id> --promote|--reject`: pending / conflict の candidate を人が昇格・棄却する。
