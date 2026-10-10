# @yunomi/cli (`ykm`)

Admin 読み取り API（`/admin/api/...`）を叩いて、Yukarin の状態・記憶・判断履歴をターミナルで見る。

```
ykm status                                   State / Relationship / 件数
ykm memory list [--candidates] [--limit N]   Fact（既定）か candidate の一覧
ykm audit tail [-n N] [-f]                   直近の audit。-f は 5 秒ごとに since で追う
```

共通オプション: `--env dev|prod`（既定 dev）、`--url`、`--partner`（既定 `yukarin`）、`--json`。`--json` は整形せず JSON を出す（`status` は `{status, relationships}`、`audit tail` は 1 行 1 件）。人間向けの出力は表で、時刻は JST。

## 接続先と認証

| 項目 | 指定 |
| --- | --- |
| URL | `--url` > `YKM_DEV_URL` / `YKM_PROD_URL` > `https://yunomi-dev.chanu.co` / `https://yunomi.chanu.co` |
| 認証 | `YKM_ACCESS_CLIENT_ID` と `YKM_ACCESS_CLIENT_SECRET` を `CF-Access-Client-Id` / `CF-Access-Client-Secret` で送る |
| ローカル | URL が `localhost` / `127.0.0.1` で token が無いときは `x-yunomi-dev-caller: ykm` を送る |

応答は `@yunomi/admin-contract` のスキーマで検証する。契約に合わなければエラーにする。終了コードは 0（成功）、1（接続・認証・設定の失敗）、2（使い方の誤り）。

## ビルドと実行

ビルドしない。Node 24 の type stripping で `src/bin.ts` を直接実行する（bin も `./src/bin.ts`）。ワークスペース依存の `@yunomi/admin-contract` も TS ソースを export しているため、tsc の出力や tsx は要らない。そのため `erasableSyntaxOnly`（enum や parameter property を使わない）を有効にしている。

```
pnpm --filter @yunomi/cli ykm status --url http://localhost:8787
```

ローカルの Worker は `pnpm --filter @yunomi/worker dev`（`cf dev --mode local`）で立てる。この mode だけが `x-yunomi-dev-caller` を信用する。

## 変更系コマンドの設計（未実装）

読み取り API は Access 経由の `ykm` に read だけを許している。次のコマンドは未実装で、実装時は Admin API に書き込み系の endpoint と別の認可（owner の操作として audit に残す）を足す。

- `ykm snapshot create`: state・relationship・facts の時点コピーを取る。復元の前提になる。
- `ykm memory delete <fact-id>`: Fact を `valid_to` で失効させる（行は消さず、履歴に残す）。
- `ykm memory candidates review <id> --promote|--reject`: pending / conflict の candidate を人が昇格・棄却する。
