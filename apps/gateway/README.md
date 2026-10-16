# @yunomi/gateway

Home の Docker 上で Discord Gateway に常時接続し、guild のテキストメッセージを Yunomi Worker へ中継して返事を送る。

## 実行方法

ビルド工程は持たず、`tsx` で TypeScript を直接実行する（`pnpm --filter @yunomi/gateway start`）。

```sh
DISCORD_TOKEN=... YUNOMI_URL=http://localhost:8787 YUNOMI_DEV_CALLER=1 \
  pnpm --filter @yunomi/gateway start
```

## 環境変数

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | はい | bot token |
| `YUNOMI_URL` | はい | Worker の URL |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 本番 | Access service token。どちらか一方だけの指定は起動時エラー |
| `YUNOMI_DEV_CALLER` | いいえ | `1` で `x-yunomi-dev-caller: gateway` を送る。Access 未設定時のみ有効で、Worker は localhost でだけ受け付ける |
| `HEARTBEAT_FILE` | いいえ | heartbeat の書き込み先（既定 `/tmp/yunomi-gateway.heartbeat`） |
| `LOG_LEVEL` | いいえ | `debug` `info` `warn` `error`（既定 `info`） |

## 挙動

- 自分の発言は中継しない。bot の発言は `author.is_bot=true` で送る。DM は対象外。
- typing は出さない。Worker が REST で出す。
- `ack`（Worker が送信まで済ませた）と `ignore` は何もしない。
- Worker が `DISCORD_SEND_FROM_WORKER=1` と `DISCORD_BOT_TOKEN` の両方を持つまで、Worker は `reply` を返す。互換のため、`reply` は `allowedMentions: { parse: [], repliedUser: false }` で送り、`@everyone` やロール宛の ping を許さない。
- `reply` は、チャンネルの直近の発言（`lastMessageId`）が宛先の発言そのものなら普通のメッセージで送り、間に他の発言があるときだけ Discord の返信形式で送る。
- `reply` を送れたら `POST /v1/partners/:partnerId/discord/sent` で、応答の `partner_message_id` と送信した Discord message id を Worker に知らせる（ユーザーが Yukarin の発言に返信したとき、Worker が reply-to-partner を判定するため）。best effort で、失敗しても warn ログだけ残して処理は続ける。再送の方針は他のリクエストと同じ。
- 5xx・429・ネットワークエラーは 1s / 2s / 4s のバックオフで最大 3 回試す（`retry-after` を優先）。それ以外の 4xx は再送しない。タイムアウトは 1 回 60 秒。
- info 以上のログに token や本文は出さない（id と文字数のみ）。
- SIGTERM / SIGINT で Discord 接続を閉じて終了する。

## Docker / Komodo

イメージは `.github/workflows/gateway-image.yml` が main への push で `ghcr.io/ochanuco/yunomi-gateway` に `sha-<short>` と `main` の tag で公開する。PR では build の成否だけを確認する。

```sh
docker build -f apps/gateway/Dockerfile -t yunomi-gateway .   # ビルドコンテキストはリポジトリルート
```

- `apps/gateway/compose.example.yaml` に dev / prod の 2 サービス（`yunomi-gateway-dev` / `yunomi-gateway`）を定義している。どちらも `restart: unless-stopped` で、再起動後に自動で再接続する。
- 環境変数は `.env.dev` / `.env.prod`（commit しない）で渡す。値は 1Password の item `chabatake-services/yunomi-dev-gateway`（prod は `yunomi-gateway`）の `discord_token` / `client_id` / `client_secret`。参照の一覧は `dev.env.op` / `production.env.op` で、手元では `op inject -i apps/gateway/dev.env.op -o .env.dev` で作れる。
  - deploy 用の Service Account が読む `yunomi-dev` / `gh-deploy` vault には置かない。Worker のデプロイに Gateway の secret は要らない。
- dev と prod は別の Discord bot token、別の `YUNOMI_URL`、別の Access service token を使う。prod は `sha-<short>` の tag に固定し、dev だけ `main` を追う。
- docker01 では chabatake リポジトリの `docker01/yunomi-gateway-dev/` と `docker01/yunomi-gateway/` を Komodo が配置する。dev を main の最新にするときは Komodo で再デプロイし、prod の版を上げるときは chabatake の `docker01/yunomi-gateway/compose.yaml` の tag を上げる PR を出す。docker01 上で手で置き換えても Komodo の配置で元に戻る。
- HEALTHCHECK は heartbeat ファイルの更新時刻を見る。Discord に接続済み（ready）の間だけ 30 秒ごとに更新し、90 秒以上古いと unhealthy になる。
- コンテナは非 root（`node` ユーザー）で動く。
