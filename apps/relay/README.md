# @yunomi/relay

Home の Docker 上で Discord Gateway に常時接続し、guild のテキストメッセージを Yunomi Worker へ中継して返事を送る。VC は扱わない。VC は同じ bot で yunomi-voice（`apps/voice`）が受け持つ。

## 実行方法

ビルド工程は持たず、`tsx` で TypeScript を直接実行する（`pnpm --filter @yunomi/relay start`）。

```sh
DISCORD_TOKEN=... YUNOMI_URL=http://localhost:8787 YUNOMI_DEV_CALLER=1 \
  pnpm --filter @yunomi/relay start
```

## 環境変数

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | はい | bot token |
| `PARTNER_ID` | いいえ | この bot が受け持つパートナー（`yukarin` / `akarin`）。既定は `yukarin`。名簿にない値は起動時エラー |
| `YUNOMI_URL` | はい | Worker の URL |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 本番 | Access service token。どちらか一方だけの指定は起動時エラー |
| `YUNOMI_DEV_CALLER` | いいえ | `1` で `x-yunomi-dev-caller: gateway` を送る。Access 未設定時のみ有効で、Worker は localhost でだけ受け付ける |
| `AVATAR_DIR` | いいえ | 表情画像のディレクトリ。`<dir>/<emotion>/*.png` の形で置く。未設定なら同梱の `apps/relay/avatars/` を使う |
| `WORK_CATEGORY_IDS` | いいえ | 仕事カテゴリの Discord カテゴリ ID（カンマ区切り）。この中の発言は Worker に送らない。仕事カテゴリは mizuya の Working が mizuya の bot で受け持つ。未設定ならすべての発言を Worker に送る |
| `SEAT_STATUS_URL` | いいえ | mizuya の Working の、席の状態を渡す口の URL（例: `http://<docker01>:8191`）。未設定なら作業中の数と使用率を出さない |
| `SEAT_STATUS_TOKEN` | `SEAT_STATUS_URL` と組 | 席の状態を渡す口と共有するトークン。`Authorization: Bearer` で送る |
| `HEARTBEAT_FILE` | いいえ | heartbeat の書き込み先（既定 `/tmp/yunomi-relay.heartbeat`） |
| `LOG_LEVEL` | いいえ | `debug` `info` `warn` `error`（既定 `info`） |

この表にない変数は読み捨てる。配置側に VC の頃の変数（`RELAY_VOICE`、`OCHOKO_URL` など）が残っていても起動する。

## 2 つ目のパートナーの relay

パートナーごとに Discord の bot を分け、relay も 1 つずつ動かす。Akarin の relay は Yukarin のものと同じイメージで、環境変数だけを変える。

| 名前 | Akarin の relay での値 |
| --- | --- |
| `PARTNER_ID` | `akarin` |
| `DISCORD_TOKEN` | Akarin の bot の token（Yukarin とは別の bot） |
| `YUNOMI_URL` / `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Yukarin の relay と同じ Worker と Access service token を使える（呼び出し元は `gateway`） |
| `WORK_CATEGORY_IDS` | Yukarin の relay と同じ値。仕事カテゴリで Akarin が雑談の返事をしないようにする |
| `SEAT_STATUS_URL` / `SEAT_STATUS_TOKEN` | Yukarin の relay と同じ値。読むのは `PARTNER_ID` の席の分なので、Akarin の bot には Akarin の席（Codex）の数と使用率が出る |
| `HEARTBEAT_FILE` / `LOG_LEVEL` / `AVATAR_DIR` | 必要なら Yukarin と同じように |

Worker 側では、Akarin の bot の user id（`AKARIN_DISCORD_USER_ID`）と token（`AKARIN_DISCORD_BOT_TOKEN`）が要る（`apps/worker/README.md` の「もうひとりのパートナー」）。user id が無いと、Akarin は自分へのメンションを見分けられず、Yukarin も Akarin の発言を第三者の発言として見分けない。

どちらの relay も、もうひとりの bot の発言を `is_bot=true` で自分のパートナーに中継する。どちらが返事をするかは Worker が決める。

## サーバーへの招待

bot の権限は、招待 URL の `permissions` でサーバーごとに決まる。bot は yunomi-voice と同じなので、VC に入るための「接続」と「発言」もここで渡す。無いと Discord は何も返さずに接続を無視する（yunomi-voice のログには、30 秒後の `voice connection not ready` だけが出る）。招待済みのサーバーでも、同じ URL を開いて承認し直せば、bot のロールの権限が置き換わる。

| 環境 | 招待 URL |
| --- | --- |
| production | `https://discord.com/oauth2/authorize?client_id=1558613526585671773&scope=bot&permissions=36801536` |
| development | `https://discord.com/oauth2/authorize?client_id=1558605895758389250&scope=bot&permissions=36801536` |

`36801536` は、チャンネルを見る・メッセージを送信・ファイルを添付・メッセージ履歴を読む・接続・発言・音声検出を使用、の 7 つ。

## 挙動

- 自分の発言は中継しない。bot の発言は `author.is_bot=true` で送る。DM は対象外。VC のテキストチャット（GuildVoice）は通常のチャンネルと同じに中継し、作者が入っている VC を `author_voice_channel_id` に載せる（guild の voice state キャッシュから読む。intent の `GuildVoiceStates` はこのために使う）。
- 発言のチャンネルの親カテゴリ（スレッドなら親チャンネルのカテゴリ）が `WORK_CATEGORY_IDS` に含まれるときは、Worker に送らない。Talking は返事をしない。それ以外のカテゴリとカテゴリ外の発言は Worker に送る。
- `SEAT_STATUS_URL` があれば、mizuya の Working の `/seat-status/<PARTNER_ID>` を 1 分おきに読み、自分の席の作業中の数と、席で動く CLI（Yukarin は Claude、Akarin は Codex）の使用率を bot のステータスに「作業中 2件 · 5h 30% · 週 12%」の形で出す。読めないときはステータスを消す。
  - 使用率は application の説明文（プロフィールの自己紹介欄）にも、5 時間枠と週枠を 1 行ずつ、リセット時刻と書いた時刻を添えて書く。変わったときだけ、15 分に一度まで。Working が一時的に読めないだけでは消さない。
- typing は出さない。Worker が REST で出す。
- `ignore` と `ack`（Worker が送信まで済ませた）は返事を送らない。応答の `voice` は読まない。
- `reply` と `ack` に `avatar: { emotion }` があれば、返事のテキストを送り終えたあとに、その感情の表情画像からランダムに 1 枚を同じチャンネルへ添付で貼る。分割された返事でも 1 回だけ。`reply` を途中までしか送れなかったときは貼らない。画像の無い感情は何もしない。
- Worker が `DISCORD_SEND_FROM_WORKER=1` と `DISCORD_BOT_TOKEN` の両方を持つまで、Worker は `reply` を返す。互換のため、`reply` は `allowedMentions: { parse: [], repliedUser: false }` で送り、`@everyone` やロール宛の ping を許さない。
- `reply` は、チャンネルの直近の発言（`lastMessageId`）が宛先の発言そのものなら普通のメッセージで送り、間に他の発言があるときだけ Discord の返信形式で送る。
- `reply` を送れたら `POST /v1/partners/:partnerId/discord/sent` で、応答の `partner_message_id` と送信した Discord message id を Worker に知らせる（ユーザーが Yukarin の発言に返信したとき、Worker が reply-to-partner を判定するため）。best effort で、失敗しても warn ログだけ残して処理は続ける。再送の方針は他のリクエストと同じ。
- 5xx・429・ネットワークエラーは 1s / 2s / 4s のバックオフで最大 3 回試す（`retry-after` を優先）。それ以外の 4xx は再送しない。タイムアウトは 1 回 60 秒。
- info 以上のログに token や本文は出さない（id と文字数のみ）。
- SIGTERM / SIGINT で Discord 接続を閉じて終了する。

## 表情画像

`apps/relay/avatars/<emotion>/` に、chagama で作ったストック（chimera で rating=good、タグ `avatar-stock` と `emotion:<name>`）を同梱し、Docker image に入れる。ディレクトリ名は `@yunomi/core` の `performanceEmotions` と同じ。起動時に一覧を作り、貼るたびにディスクから読む。差し替えは画像を入れ替える PR で行う。

## Docker

イメージは `.github/workflows/relay-image.yml` が main への push で `ghcr.io/ochanuco/yunomi-relay` に `sha-<short>` と `main` の tag で公開する。PR では build の成否だけを確認する。公開の後、`deploy-dev` job が chabatake の `docker01-app` を dispatch して dev に配置する。prod とあかりは、dev で確かめて Environment `production-approval` で承認すると `deploy` job が配置する（`ochanuco/.github` の `actions/chabatake-dispatch`）。

```sh
docker build -f apps/relay/Dockerfile -t yunomi-relay .   # ビルドコンテキストはリポジトリルート
```

- `apps/relay/compose.example.yaml` に dev / prod の 2 サービス（`yunomi-relay-dev` / `yunomi-relay`）を定義している。どちらも `restart: unless-stopped` で、再起動後に自動で再接続する。
- 環境変数は `.env.dev` / `.env.prod`（commit しない）で渡す。値は 1Password の item `yunomi-relay-dev`（prod は `yunomi-relay`）の `discord_shizuku_bot_token`（prod は `discord_yukarin_bot_token`）/ `cf_access_yunomi_client_id` / `cf_access_yunomi_client_secret`。参照の一覧は `dev.env.op` / `production.env.op` で、手元では `op inject -i apps/relay/dev.env.op -o .env.dev` で作れる。
  - deploy 用の Service Account が読む `yunomi-dev` / `gh-deploy` vault には置かない。Worker のデプロイに relay の secret は要らない。
- dev と prod は別の Discord bot token、別の `YUNOMI_URL`、別の Access service token を使う。prod は `sha-<short>` の tag に固定し、dev だけ `main` を追う。
- 実際に動かすホストでの配置（compose ファイルと tag の管理）はこのリポジトリの外で行う。prod の版を上げるときは、配置側の compose の tag を上げる。
- HEALTHCHECK は heartbeat ファイルの更新時刻を見る。Discord に接続済み（ready）の間だけ 30 秒ごとに更新し、90 秒以上古いと unhealthy になる。
- コンテナは非 root（`node` ユーザー）で動く。`read_only: true`（書き込みは tmpfs の `/tmp` の heartbeat だけ）、`cap_drop: ALL`、`no-new-privileges` で動作を確認している。
