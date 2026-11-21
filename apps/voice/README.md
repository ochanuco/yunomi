# @yunomi/voice

会話の器官 yunomi-voice。yunomi-box で ochoko（声）と kukicha（耳）の隣に動き、Discord の VC への出入り、返事の声の再生、持ち主の声の聞き取りを受け持つ。テキストの中継は relay（`apps/relay`）が受け持つ。

パートナーの bot の token で Discord の Gateway にもう 1 本つなぐ。intent は `Guilds` と `GuildVoiceStates` だけで、発言は受け取らない。

## 実行方法

ビルド工程は持たず、`tsx` で TypeScript を直接実行する。再生する WAV の変換に ffmpeg を使うので、PATH に入れておく。

```sh
DISCORD_TOKEN=... YUNOMI_URL=http://localhost:8787 YUNOMI_DEV_CALLER=1 \
  pnpm --filter @yunomi/voice start
```

relay も同じ bot で VC の出入りを扱う。両方が同じ bot・同じ Worker で動くと、VC の指示に二重に従う。yunomi-voice を動かすときは、relay を `RELAY_VOICE=off` で動かす。

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

VC の出入り、再生、keep_awake、耳の振る舞いは relay の README の「VC」と同じ。違いは、発話への応答の扱いだけである。

- 人の VC 出入りを `POST /v1/interfaces/discord/voice-events` に送り、応答の `voice_join` / `voice_leave` に従う。実際の接続先は `POST /v1/partners/:partnerId/discord/voice-connection` に知らせ、起動時は参加している全 guild に `null` を送る。
- 持ち主の発話は kukicha で文字にし、`discord.voice.utterance` として `POST /v1/interfaces/discord/events` に送る。
- 応答のうち実行するのは `voice`（join → speak → leave）だけ。テキストと表情画像は Worker が REST で送るので、yunomi-voice は送らない。`reply` が返ってきたときは `voice` だけを実行し、テキストが届かないことを warn ログに残す。
- VC のテキストチャットに書かれた発言への声の指示は、relay ではなく yunomi-voice に届く（下の「声の指示の WebSocket」）。
- info 以上のログに token・音声・発話の文字は出さない。
- SIGTERM / SIGINT で VC と Discord の接続を閉じて終了する。

## 声の指示の WebSocket

ClientReady のあと、`${YUNOMI_URL}/v1/partners/:partnerId/voice/socket`（`https` は `wss` に読み替える）に WebSocket をつなぐ。ヘッダーは HTTP の口と同じで、Access の service token か、ローカル開発では `x-yunomi-dev-caller: voice` を送る。Node の WebSocket が任意のヘッダーを受け付けるので、追加の依存は持たない。Worker 側の受け口は `apps/worker/README.md` の「声の指示の WebSocket」。

- 30 秒ごとに `ping` を送る。PartnerDO は起きずに `pong` を返し、yunomi-voice は `pong` を読み捨てる。
- 届いたメッセージは `voiceSocketMessageSchema` で検証する。読めないものと、ほかのパートナー宛ての指示は warn ログを残して捨てる。
- `voice.directive` の `voice` は、HTTP の応答の `voice` と同じに VoiceManager に渡す（join → speak → leave）。接続していない VC への `speak` は VoiceManager が捨てる。
- close か error で切れたら、つなぎ直す。待ち時間の上限は 1 秒から倍々に 60 秒まで伸ばし、実際の待ち時間は上限の半分から上限のあいだで揺らす。60 秒続いた接続のあとに切れたら、1 秒から数え直す。
- 切れているあいだに Worker が送れなかった指示は、Worker が relay への応答に載せる。relay を `RELAY_VOICE=off` で動かしていれば、その指示は流れない。
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

relay と同じ bot・同じ Worker で動くので、設定を置く前に relay の prod を `RELAY_VOICE=off` にする。設定がなければ prepare.ps1 が落ち、版は切り替わらず起動もしない。

### 初回の準備

yunomi-box で一度だけ行う。

1. Node 24 を入れ、chanu のログオンのセッションと apps runner の両方で `node` が PATH にあるようにする（または環境変数 `NODE` に `node.exe` の場所を入れる）。ffmpeg も PATH に入れる。
2. 管理者の PowerShell で `apps\voice\deploy\register.ps1` を実行する。`C:\apps\yunomi-voice\{releases,data}`、`C:\ProgramData\yunomi-voice`（管理者と SYSTEM は全権、実行ユーザーは読むだけ）、ログオン時に非昇格で動き、落ちたら 1 分おきに 3 回まで起こし直すタスク `yunomi-voice` を用意する。
3. 上の「設定」の `config.json` と `tokens.json` を管理者権限で置く。
