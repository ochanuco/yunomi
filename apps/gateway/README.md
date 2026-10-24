# @yunomi/gateway

Home の Docker 上で Discord Gateway に常時接続し、guild のテキストメッセージを Yunomi Worker へ中継して返事を送る。Worker の指示で VC に入り、返事を A.I.VOICE の声で再生する。

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
| `OCHOKO_URL` / `AIVOICE_TOKEN` | いいえ | 自宅 LAN の ochoko の URL（例 `http://192.168.10.254:8190`）と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら VC の出入りは動くが、`speak` は捨て、keep_awake は送らない（警告ログは 1 回） |
| `OWNER_DISCORD_USER_ID` | いいえ | VC でこの人の声だけを聞く。未設定なら耳を閉じて入る |
| `KUKICHA_URL` / `KUKICHA_TOKEN` | いいえ | STT 器官（kukicha）の URL と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら聞いた発話は文字にせず、長さだけをログに残して捨てる |
| `AVATAR_DIR` | いいえ | 表情画像のディレクトリ。`<dir>/<emotion>/*.png` の形で置く。未設定なら同梱の `apps/gateway/avatars/` を使う |
| `HEARTBEAT_FILE` | いいえ | heartbeat の書き込み先（既定 `/tmp/yunomi-gateway.heartbeat`） |
| `LOG_LEVEL` | いいえ | `debug` `info` `warn` `error`（既定 `info`） |

## サーバーへの招待

bot の権限は、招待 URL の `permissions` でサーバーごとに決まる。VC に入るには「接続」と「発言」が要り、無いと Discord は何も返さずに接続を無視する（Gateway のログには、30 秒後の `voice connection not ready` だけが出る）。招待済みのサーバーでも、同じ URL を開いて承認し直せば、bot のロールの権限が置き換わる。

| 環境 | 招待 URL |
| --- | --- |
| production | `https://discord.com/oauth2/authorize?client_id=1558613526585671773&scope=bot&permissions=36801536` |
| development | `https://discord.com/oauth2/authorize?client_id=1558605895758389250&scope=bot&permissions=36801536` |

`36801536` は、チャンネルを見る・メッセージを送信・ファイルを添付・メッセージ履歴を読む・接続・発言・音声検出を使用、の 7 つ。

## 挙動

- 自分の発言は中継しない。bot の発言は `author.is_bot=true` で送る。DM は対象外。VC のテキストチャット（GuildVoice）は通常のチャンネルと同じに中継し、作者が入っている VC を `author_voice_channel_id` に載せる（guild の voice state キャッシュから読む）。
- typing は出さない。Worker が REST で出す。
- `ignore` は何もしない。`ack`（Worker が送信まで済ませた）は、`voice` があるときだけ VC を操作する。
- `reply` と `ack` に `avatar: { emotion }` があれば、返事のテキストを送り終えたあとに、その感情の表情画像からランダムに 1 枚を同じチャンネルへ添付で貼る。分割された返事でも 1 回だけ。`reply` を途中までしか送れなかったときは貼らない。画像の無い感情は何もしない。
- Worker が `DISCORD_SEND_FROM_WORKER=1` と `DISCORD_BOT_TOKEN` の両方を持つまで、Worker は `reply` を返す。互換のため、`reply` は `allowedMentions: { parse: [], repliedUser: false }` で送り、`@everyone` やロール宛の ping を許さない。
- `reply` は、チャンネルの直近の発言（`lastMessageId`）が宛先の発言そのものなら普通のメッセージで送り、間に他の発言があるときだけ Discord の返信形式で送る。
- `reply` を送れたら `POST /v1/partners/:partnerId/discord/sent` で、応答の `partner_message_id` と送信した Discord message id を Worker に知らせる（ユーザーが Yukarin の発言に返信したとき、Worker が reply-to-partner を判定するため）。best effort で、失敗しても warn ログだけ残して処理は続ける。再送の方針は他のリクエストと同じ。
- 5xx・429・ネットワークエラーは 1s / 2s / 4s のバックオフで最大 3 回試す（`retry-after` を優先）。それ以外の 4xx は再送しない。タイムアウトは 1 回 60 秒。
- info 以上のログに token や本文は出さない（id と文字数のみ）。
- SIGTERM / SIGINT で Discord 接続を閉じて終了する。

## 表情画像

`apps/gateway/avatars/<emotion>/` に、chagama で作ったストック（chimera で rating=good、タグ `avatar-stock` と `emotion:<name>`）を同梱し、Docker image に入れる。ディレクトリ名は `@yunomi/core` の `performanceEmotions` と同じ。起動時に一覧を作り、貼るたびにディスクから読む。差し替えは画像を入れ替える PR で行う。

## VC

intent に `GuildVoiceStates` を使う。同時に入る VC は 1 つで、別の VC を指示されたら接続を移す（別の guild なら先に切る）。`OWNER_DISCORD_USER_ID` が無ければ耳を閉じて（`selfDeaf`）入る。Discord は耳を閉じた参加者には音声を送らない。

### 出入り

- 人の VC 出入り（チャンネルが変わった更新だけ。ミュート切り替えと partner 自身の更新は無視）を `POST /v1/interfaces/discord/voice-events` で Worker に送る。人数は bot を除き、変化後の値。`partner_channel_id` は Gateway が実際に接続している VC。応答の `voice_join` / `voice_leave` / `ignore` に従う。
- 応答の `voice`（`reply` と `ack` に載る）は join → speak → leave の順に実行する。`speak` は、その VC に接続中のときだけ受け付け、それ以外は警告ログを出して捨てる。leave は再生待ちの発話を待たずに切る。
- 接続が Ready になったら `POST /v1/partners/:partnerId/discord/voice-connection` に `{guild_id, channel_id, listening}` を送る。`listening` は、聞いた発話を Worker まで届けられる（`OWNER_DISCORD_USER_ID` と `KUKICHA_URL` がある）ときだけ `true`。切断（自分で出た・追い出された・チャンネル削除・復帰できなかった）では `channel_id: null`・`listening: false` を送る。起動時（ClientReady）は参加している全 guild に `null` を送り、Worker の古い状態を消す。
- Disconnected は @discordjs/voice の標準の手順で扱う。別の VC への移動（close code 4014）は 5 秒だけ Connecting を待ち、それ以外は 5 秒刻みで最大 5 回 rejoin し、だめなら destroy する。

### 声

- 合成は ochoko を直接呼ぶ（`POST {OCHOKO_URL}/mcp`、JSON-RPC `tools/call`、`Authorization: Bearer`。Cloudflare Access は通さない）。リクエストとエラーの分類は `apps/worker/src/ochoko.ts` の `synthesize` と同じ。Worker 側は Access ヘッダー・Workers 型・`SpeechPort` の組み立てと一体なので共通化せず、Gateway 側に最小限を写した。
- GPU 機が寝ている間は接続エラー・タイムアウト・5xx・429・busy が返る（Gateway は wol を打てず、起こすのは Worker）。再試行できる失敗は 5 秒おきに、発話ごとに 2 分の期限まで試し、超えたら警告ログを出して捨てる。認証エラーや不正な応答は再試行しない。
- 発話は VC ごとに 1 本のキューに入れ、1 つの AudioPlayer で順番に再生する。
- 変換は ffmpeg（`StreamType.Arbitrary`）に WAV を stdin から流し、48kHz ステレオにする。ファイルは作らず、読み取り専用のルートファイルシステムでも動く。WAV のサンプル形式やレートを自前で扱わずに済むため ffmpeg を選んだ（イメージは大きくなる）。
- VC にいる間、ochoko の `keep_awake`（`ttl_seconds: 900`、`partner_id: yukarin`）を Ready 直後と 5 分ごとに呼ぶ。失敗は警告ログだけで、次の周期で再び試す。切断で止める。
- ログに token と音声は出さない（発話は文字数だけ）。

### 耳

- `OWNER_DISCORD_USER_ID` の人が話し始めると（receiver の `speaking` の `start`）、その人の音声を購読する。他の人の声は購読しない。
- 購読は 700ms 音声が途切れたら終わり、そこまでを 1 つの発話にする。この待ちは、そのまま返事までの遅れに乗る。
- Opus はパケットごとに 16kHz mono の 16bit PCM へデコードし、WAV にする。デコードで直接この形にするので、変換は要らない。壊れたパケットは飛ばす。
- 300ms に満たない発話は捨てる。30 秒を超えたらそこで区切り、続きは次の発話にする。
- 発話には、その時点で接続している VC を付ける。VC を出たあとに終わった途中の発話は捨てる。
- 再接続で Ready に戻っても、同じ receiver で聞き続ける。
- `KUKICHA_URL` があれば、発話を STT 器官で文字にする（`POST {KUKICHA_URL}/mcp`、JSON-RPC `tools/call` の `transcribe`、`Authorization: Bearer`）。`speaker` は `OWNER_DISCORD_USER_ID` で、器官はこの人の声と判定した部分だけを文字にする。
- 文字が空なら、持ち主の発話は無かったとして何もしない。空でなければ `discord.voice.utterance` の Envelope（`occurred_at` は話し始めた時刻、表示名は guild の member キャッシュから読む）を、テキストと同じ `POST /v1/interfaces/discord/events` に送る。再送の方針もテキストと同じ。
- 応答はテキストのときと同じに扱う。`voice` は VC を操作し、`reply` は発話を聞いた VC のテキストチャットへ送る。発話には Discord のメッセージが無いので、返信形式にはしない。
- 発話は時間が経つと返事の意味が薄れるので、STT 器官の失敗は長く待たない。接続エラー・タイムアウト（30 秒）・5xx だけ 1 回やり直し、それでも失敗したら warn ログを出して捨て、次の発話に進む。
- 返事が話した順に並ぶよう、同じ VC の発話は順に扱う。前の発話の文字起こしと送信が終わってから、次の発話を文字にする。
- info 以上のログに音声も文字も出さない（発話は長さ、文字は文字数だけ）。

### 依存

| 用途 | 採用 |
| --- | --- |
| VC 接続 | `@discordjs/voice`（DAVE 対応版） |
| E2EE（DAVE） | `@snazzah/davey`（`@discordjs/voice` の依存。ビルド済みバイナリ） |
| Opus | `opusscript`（WASM。ビルドツール不要。prism-media の peer の版 0.0.8 に固定）。耳のデコードにも使う |
| 暗号 | Node 組み込みの `aes-256-gcm`（libsodium 不要） |
| 変換 | ffmpeg（Docker の実行ステージで apt から入れる。ローカル実行では PATH に必要） |

起動時に `generateDependencyReport()` を debug ログに出す。

## Docker

イメージは `.github/workflows/gateway-image.yml` が main への push で `ghcr.io/ochanuco/yunomi-gateway` に `sha-<short>` と `main` の tag で公開する。PR では build の成否だけを確認する。

```sh
docker build -f apps/gateway/Dockerfile -t yunomi-gateway .   # ビルドコンテキストはリポジトリルート
```

- `apps/gateway/compose.example.yaml` に dev / prod の 2 サービス（`yunomi-gateway-dev` / `yunomi-gateway`）を定義している。どちらも `restart: unless-stopped` で、再起動後に自動で再接続する。
- 環境変数は `.env.dev` / `.env.prod`（commit しない）で渡す。値は 1Password の item `yunomi-dev-gateway`（prod は `yunomi-gateway`）の `discord_token` / `client_id` / `client_secret` / `owner_discord_user_id`。参照の一覧は `dev.env.op` / `production.env.op` で、手元では `op inject -i apps/gateway/dev.env.op -o .env.dev` で作れる。
  - deploy 用の Service Account が読む `yunomi-dev` / `gh-deploy` vault には置かない。Worker のデプロイに Gateway の secret は要らない。
- dev と prod は別の Discord bot token、別の `YUNOMI_URL`、別の Access service token を使う。prod は `sha-<short>` の tag に固定し、dev だけ `main` を追う。
- 実際に動かすホストでの配置（compose ファイルと tag の管理）はこのリポジトリの外で行う。prod の版を上げるときは、配置側の compose の tag を上げる。
- HEALTHCHECK は heartbeat ファイルの更新時刻を見る。Discord に接続済み（ready）の間だけ 30 秒ごとに更新し、90 秒以上古いと unhealthy になる。
- コンテナは非 root（`node` ユーザー）で動く。`read_only: true`（書き込みは tmpfs の `/tmp` の heartbeat だけ）、`cap_drop: ALL`、`no-new-privileges` で動作を確認している。VC の音声の変換はメモリ上のストリームで、ファイルを書かない。
- 外向きの UDP（Discord の音声サーバー）と、ochoko への HTTP が通ること。
