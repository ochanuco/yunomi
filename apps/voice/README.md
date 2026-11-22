# @yunomi/voice

会話の器官 yunomi-voice。yunomi-box で ochoko（声）と kukicha（耳）の隣に動き、Discord の VC への出入り、返事の声の再生、持ち主の声の聞き取りを受け持つ。テキストの中継は relay（`apps/relay`）が受け持つ。

パートナーの bot の token で Discord の Gateway にもう 1 本つなぐ。intent は `Guilds` と `GuildVoiceStates` だけで、発言は受け取らない。

## 実行方法

ビルド工程は持たず、`tsx` で TypeScript を直接実行する。再生する WAV の変換に ffmpeg を使うので、PATH に入れておく。

```sh
DISCORD_TOKEN=... YUNOMI_URL=http://localhost:8787 YUNOMI_DEV_CALLER=1 \
  pnpm --filter @yunomi/voice start
```

relay とは同じ bot を使う。relay はテキストの中継だけをし、VC は yunomi-voice だけが扱う。

## 環境変数

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | はい | パートナーの bot の token（relay と同じ bot） |
| `PARTNER_ID` | いいえ | この bot が受け持つパートナー（`yukarin` / `akarin`）。既定は `yukarin`。名簿にない値は起動時エラー |
| `YUNOMI_URL` | はい | Worker の URL |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 本番 | Access service token。どちらか一方だけの指定は起動時エラー |
| `YUNOMI_DEV_CALLER` | いいえ | `1` で `x-yunomi-dev-caller: voice` を送る。Access 未設定時のみ有効で、Worker は localhost でだけ受け付ける |
| `OCHOKO_URL` / `AIVOICE_TOKEN` | いいえ | ochoko の URL（例 `http://localhost:8190`）と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら VC の出入りは動くが、`speak` は捨て、keep_awake は送らない |
| `OWNER_DISCORD_USER_ID` | いいえ | VC でこの人の声だけを聞く。未設定なら耳を閉じて入る |
| `KUKICHA_URL` / `KUKICHA_TOKEN` | いいえ | kukicha の URL と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら聞いた発話は文字にせず、長さだけをログに残して捨てる |
| `LOG_LEVEL` | いいえ | `debug` `info` `warn` `error`（既定 `info`） |

## 挙動

- 人の VC 出入りを `POST /v1/interfaces/discord/voice-events` に送り、応答の `voice_join` / `voice_leave` に従う。実際の接続先は `POST /v1/partners/:partnerId/discord/voice-connection` に知らせ、起動時は参加している全 guild に `null` を送る。
- 持ち主の発話は kukicha で文字にし、`discord.voice.utterance` として `POST /v1/interfaces/discord/events` に送る。
- 応答のうち実行するのは `voice`（join → speak → leave）だけ。テキストと表情画像は Worker が REST で送るので、yunomi-voice は送らない。`reply` が返ってきたときは `voice` だけを実行し、テキストが届かないことを warn ログに残す。
- VC のテキストチャットに書かれた発言への声の指示は、relay ではなく yunomi-voice に届く（下の「声の指示の WebSocket」）。
- info 以上のログに token・音声・発話の文字は出さない。
- SIGTERM / SIGINT で VC と Discord の接続を閉じて終了する。

## VC

同時に入る VC は 1 つで、別の VC を指示されたら接続を移す（別の guild なら先に切る）。`OWNER_DISCORD_USER_ID` が無ければ耳を閉じて（`selfDeaf`）入る。Discord は耳を閉じた参加者には音声を送らない。

### 出入り

- 人の VC 出入り（チャンネルが変わった更新だけ。ミュート切り替えと partner 自身の更新は無視）を `POST /v1/interfaces/discord/voice-events` で Worker に送る。人数は bot を除き、変化後の値。`partner_channel_id` は yunomi-voice が実際に接続している VC。応答の `voice_join` / `voice_leave` / `ignore` に従う。
- 応答と WebSocket で届く `voice` は join → speak → leave の順に実行する。`speak` は、その VC に接続中のときだけ受け付け、それ以外は警告ログを出して捨てる。leave は再生待ちの発話を待たずに切る。
- 接続が Ready になったら `POST /v1/partners/:partnerId/discord/voice-connection` に `{guild_id, channel_id, listening}` を送る。`listening` は、聞いた発話を Worker まで届けられる（`OWNER_DISCORD_USER_ID` と `KUKICHA_URL` がある）ときだけ `true`。切断（自分で出た・追い出された・チャンネル削除・復帰できなかった）では `channel_id: null`・`listening: false` を送る。起動時（ClientReady）は参加している全 guild に `null` を送り、Worker の古い状態を消す。
- Disconnected は @discordjs/voice の標準の手順で扱う。別の VC への移動（close code 4014）は 5 秒だけ Connecting を待ち、それ以外は 5 秒刻みで最大 5 回 rejoin し、だめなら destroy する。

### 声

- 合成は ochoko を直接呼ぶ（`POST {OCHOKO_URL}/mcp`、JSON-RPC `tools/call`、`Authorization: Bearer`。Cloudflare Access は通さない）。リクエストとエラーの分類は `apps/worker/src/ochoko.ts` の `synthesize` と同じ。Worker 側は Access ヘッダー・Workers 型・`SpeechPort` の組み立てと一体なので共通化せず、yunomi-voice 側に最小限を写した。
- ochoko に一時的につながらないと、接続エラー・タイムアウト・5xx・429・busy が返る。再試行できる失敗は 5 秒おきに、発話ごとに 2 分の期限まで試し、超えたら警告ログを出して捨てる。認証エラーや不正な応答は再試行しない。
- 発話は VC ごとに 1 本のキューに入れ、1 つの AudioPlayer で順番に再生する。
- 変換は ffmpeg（`StreamType.Arbitrary`）に WAV を stdin から流し、48kHz ステレオにする。ファイルは作らない。WAV のサンプル形式やレートを自前で扱わずに済むため ffmpeg を選んだ。
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
| 変換 | ffmpeg（PATH に必要） |

起動時に `generateDependencyReport()` を debug ログに出す。

## 声の指示の WebSocket

ClientReady のあと、`${YUNOMI_URL}/v1/partners/:partnerId/voice/socket`（`https` は `wss` に読み替える）に WebSocket をつなぐ。ヘッダーは HTTP の口と同じで、Access の service token か、ローカル開発では `x-yunomi-dev-caller: voice` を送る。Node の WebSocket が任意のヘッダーを受け付けるので、追加の依存は持たない。Worker 側の受け口は `apps/worker/README.md` の「声の指示の WebSocket」。

- 30 秒ごとに `ping` を送る。PartnerDO は起きずに `pong` を返し、yunomi-voice は `pong` を読み捨てる。
- 届いたメッセージは `voiceSocketMessageSchema` で検証する。読めないものと、ほかのパートナー宛ての指示は warn ログを残して捨てる。
- `voice.directive` の `voice` は、HTTP の応答の `voice` と同じに VoiceManager に渡す（join → speak → leave）。接続していない VC への `speak` は VoiceManager が捨てる。
- close か error で切れたら、つなぎ直す。待ち時間の上限は 1 秒から倍々に 60 秒まで伸ばし、実際の待ち時間は上限の半分から上限のあいだで揺らす。60 秒続いた接続のあとに切れたら、1 秒から数え直す。
- 切れているあいだに Worker が送れなかった指示は、Worker が relay への応答に載せる。relay は応答の `voice` を読まないので、その指示は流れない。
- SIGTERM / SIGINT では、つなぎ直しをやめてから閉じる。

## 配備

yunomi-box（Windows）へは chabatake の `gpu-box-app` で配る（chabatake の `docs/gpu-box-apps.md`、許可リスト `gpu-box/apps/yunomi-voice.json`）。

- main に `apps/voice`・`packages/core`・`packages/protocol`・`pnpm-lock.yaml` の変更が入ると、`.github/workflows/voice-release.yml` が windows-latest で zip を作る。Environment `production-approval` の承認の後に Release `voice-r<run>-<sha7>`（asset `yunomi-voice-win-x64.zip`）を公開し、その版を gpu-box-app に渡して配備させ、結果を待つ。
- zip は `pnpm deploy --prod`（hoisted）の結果で、win32-x64 の `node_modules`、`src`、`deploy\`、`release.json`（`version`、`commit`）を持つ。Node は同梱しない。
- タスク `yunomi-voice` が `C:\apps\yunomi-voice\current\deploy\run.ps1` を動かす。run.ps1 は設定を環境変数にして、`releases\<版>` で `node --import tsx src\main.ts` を動かす。node は環境変数 `NODE`、なければ PATH から探す。ログは `C:\apps\yunomi-voice\data\logs\yunomi-voice-<起動した日>.log` に足していき、14 日より古いものは起動時に消す。
- Windows では SIGTERM を送れないので、止めるときは node をそのまま終わらせる。VC と Discord の接続は相手側で切れる。

| フック | 確かめること |
| --- | --- |
| `prepare.ps1` | Node 24 以上があり、`config.json` と `tokens.json` が読め、`DISCORD_TOKEN` と `YUNOMI_URL` がある。ffmpeg がなければ警告だけ |
| `stop.ps1` | タスクを止め、`C:\apps\yunomi-voice` の下を動かす `node.exe`・`cmd.exe`・`run.ps1` をプロセスツリーごと終わらせる |
| `check.ps1` | 配備した版の `node.exe` が 60 秒以内に起動し、20 秒後も同じプロセスが動いている。設定の誤りと Discord へのログインの失敗はここで落ちる。受ける口を持たないので、Worker・ochoko・kukicha に届くかは見ない。失敗したらログの末尾を出す |

### 設定

`C:\ProgramData\yunomi-voice` の 2 つのファイルに、環境変数の名前から文字列への平らな JSON で書く。どちらに書いても同じ環境変数になるが、秘密は `tokens.json` に分ける。

`config.json`:

```json
{
  "YUNOMI_URL": "https://yunomi.chanu.co",
  "PARTNER_ID": "yukarin",
  "OWNER_DISCORD_USER_ID": "<持ち主の Discord のユーザー ID>",
  "OCHOKO_URL": "http://127.0.0.1:8190",
  "KUKICHA_URL": "http://127.0.0.1:8191",
  "LOG_LEVEL": "info"
}
```

`tokens.json`:

```json
{
  "DISCORD_TOKEN": "<パートナーの bot の token>",
  "CF_ACCESS_CLIENT_ID": "<Access の Client ID>",
  "CF_ACCESS_CLIENT_SECRET": "<Access の Client Secret>",
  "AIVOICE_TOKEN": "<ochoko の Bearer token>",
  "KUKICHA_TOKEN": "<kukicha の Bearer token>"
}
```

| 環境変数 | 1Password |
| --- | --- |
| `DISCORD_TOKEN` | `chabatake-services/yunomi-relay` の `discord_yukarin_bot_token`（relay と同じ bot） |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | `chabatake-services/yunomi-voice` の `cf_access_yunomi_client_id` / `cf_access_yunomi_client_secret` |
| `AIVOICE_TOKEN` | `chabatake-services/yunomi-relay` の `ochoko_api_token`（ochoko の `tokens.json` の prod） |
| `KUKICHA_TOKEN` | `chabatake-services/yunomi-relay` の `kukicha_api_token`（kukicha の `tokens.json` の prod） |
| `OWNER_DISCORD_USER_ID` | `chabatake-services/yunomi-relay` の `discord_owner_user_id` |

設定がなければ prepare.ps1 が落ち、版は切り替わらず起動もしない。

### 初回の準備

yunomi-box で一度だけ行う。

1. Node 24 を入れ、chanu のログオンのセッションと apps runner の両方で `node` が PATH にあるようにする（または環境変数 `NODE` に `node.exe` の場所を入れる）。ffmpeg も PATH に入れる。
2. 管理者の PowerShell で `apps\voice\deploy\register.ps1` を実行する。`C:\apps\yunomi-voice\{releases,data}`、`C:\ProgramData\yunomi-voice`（管理者と SYSTEM は全権、実行ユーザーは読むだけ）、ログオン時に非昇格で動き、落ちたら 1 分おきに 3 回まで起こし直すタスク `yunomi-voice` を用意する。
3. 上の「設定」の `config.json` と `tokens.json` を管理者権限で置く。
