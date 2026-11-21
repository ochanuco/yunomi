# @yunomi/voice

会話の器官 yunomi-voice。yunomi-box で ochoko（声）と kukicha（耳）の隣に動き、Discord の VC への出入り、返事の声の再生、持ち主の声の聞き取りを受け持つ。テキストの中継は relay（`apps/relay`）が受け持つ。

パートナーの bot の token で Discord の Gateway にもう 1 本つなぐ。intent は `Guilds` と `GuildVoiceStates` だけで、発言は受け取らない。

## 実行方法

ビルド工程は持たず、`tsx` で TypeScript を直接実行する。再生する WAV の変換に ffmpeg を使うので、PATH に入れておく。

```sh
DISCORD_TOKEN=... YUNOMI_URL=http://localhost:8787 YUNOMI_DEV_CALLER=1 \
  pnpm --filter @yunomi/voice start
```

relay も同じ bot で VC の出入りを扱う。両方が同じ bot・同じ Worker で動くと、VC の指示に二重に従うので、同時には動かさない。

## 環境変数

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | はい | パートナーの bot の token（relay と同じ bot） |
| `PARTNER_ID` | いいえ | この bot が受け持つパートナー（`yukarin` / `akarin`）。既定は `yukarin`。名簿にない値は起動時エラー |
| `YUNOMI_URL` | はい | Worker の URL |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | 本番 | Access service token。どちらか一方だけの指定は起動時エラー |
| `YUNOMI_DEV_CALLER` | いいえ | `1` で `x-yunomi-dev-caller: gateway` を送る。Access 未設定時のみ有効で、Worker は localhost でだけ受け付ける |
| `OCHOKO_URL` / `AIVOICE_TOKEN` | いいえ | ochoko の URL（例 `http://localhost:8190`）と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら VC の出入りは動くが、`speak` は捨て、keep_awake は送らない |
| `OWNER_DISCORD_USER_ID` | いいえ | VC でこの人の声だけを聞く。未設定なら耳を閉じて入る |
| `KUKICHA_URL` / `KUKICHA_TOKEN` | いいえ | kukicha の URL と Bearer token。どちらか一方だけの指定は起動時エラー。未設定なら聞いた発話は文字にせず、長さだけをログに残して捨てる |
| `LOG_LEVEL` | いいえ | `debug` `info` `warn` `error`（既定 `info`） |

## 挙動

VC の出入り、再生、keep_awake、耳の振る舞いは relay の README の「VC」と同じ。違いは、発話への応答の扱いだけである。

- 人の VC 出入りを `POST /v1/interfaces/discord/voice-events` に送り、応答の `voice_join` / `voice_leave` に従う。実際の接続先は `POST /v1/partners/:partnerId/discord/voice-connection` に知らせ、起動時は参加している全 guild に `null` を送る。
- 持ち主の発話は kukicha で文字にし、`discord.voice.utterance` として `POST /v1/interfaces/discord/events` に送る。
- 応答のうち実行するのは `voice`（join → speak → leave）だけ。テキストと表情画像は Worker が REST で送るので、yunomi-voice は送らない。`reply` が返ってきたときは `voice` だけを実行し、テキストが届かないことを warn ログに残す。
- info 以上のログに token・音声・発話の文字は出さない。
- SIGTERM / SIGINT で VC と Discord の接続を閉じて終了する。
