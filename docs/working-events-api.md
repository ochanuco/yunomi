# 出来事の口（Working events API）

Working の席で起きた出来事を、yunomi の Worker に知らせる HTTP API。今のクライアントは [ochanuco/mizuya](https://github.com/ochanuco/mizuya) の Working（`apps/working`）だけ。

Worker は席（仕事フォーラムの投稿）ごとに最新の出来事を 1 件だけ D1 に持つ。Talking はオーナーが話し相手のターンに、それを「今の仕事」として prompt に載せる。出来事が届いても Talking のターンは起きず、Discord には何も書かない。

## 接続

| 項目 | 値 |
| --- | --- |
| URL | `<Worker の URL>/v1/partners/:partnerId/working/events` |
| `partnerId` | `yukarin` か `akarin`。ほかは 404 `unknown_partner` |
| 認証 | 記憶の口（[working-memory-api.md](working-memory-api.md)）と同じ Cloudflare Access の service token。`working` に引かれた token だけを通す |
| 本文 | JSON（`Content-Type: application/json`） |

認証に失敗すると 401、`working` でない呼び手は 403 `forbidden`。

## 相手の指定

出来事は席の持ち主ではなく、席そのもの（仕事フォーラムの投稿の ID、`thread_id`）で指す。同じ partner の同じ `thread_id` に届いた出来事は、前の出来事を置き換える。

## 失敗の形

```json
{ "error": "<種類>", "message": "<理由（あれば）>" }
```

| status | `error` | いつ |
| --- | --- | --- |
| 400 | `invalid_json` | 本文が JSON として読めない |
| 400 | `validation_failed` | 本文が下の形に合わない。`message` に理由 |
| 404 | `unknown_partner` | partner が無い |
| 405 | `method_not_allowed` | POST 以外 |

## POST: 出来事を知らせる

```json
{
  "thread_id": "<数字だけ>",
  "title": "<席の件名>",
  "event": "started | asking | done | failed",
  "status": "完了 | 見張り中 | 引き継ぎ | null",
  "summary": "<1 行 | null>",
  "at": "2026-11-22T12:00:00+09:00"
}
```

| 項目 | 形 |
| --- | --- |
| `thread_id` | 席の Discord の投稿の ID。数字だけ |
| `title` | 席の件名。改行なし、前後の空白を除いて 1 〜 100 字 |
| `event` | `started`（席が動き出した）、`asking`（オーナーの判断を待っている）、`done`（終えた）、`failed`（失敗した） |
| `status` | `done` のときだけ `完了`・`見張り中`・`引き継ぎ` のどれか。ほかの `event` では null か省く |
| `summary` | 改行なし、前後の空白を除いて 200 字まで。null か省いてもよい。`started` は依頼の要旨、`asking` は聞きたいこと、`done` は報告の要旨、`failed` は理由 |
| `at` | 出来事が起きた時刻。秒まで書いたタイムゾーン付きの ISO 8601 |

- 成功すると 204 で本文は無い。
- 席が持っている出来事の `at` より古い出来事は捨てる。そのときも 204 を返す。同じ `at` なら置き換える。送り直しても結果は変わらない。
- 置き換えるときは全項目を書き換える。`done` の後に同じ席の `started` が届くと、`status` と `summary` は新しい出来事のものになる。
- Working が「決めてほしい」で席を閉じるときは、`done` ではなく `asking` を送る。

Talking の prompt の「今の仕事」には、`started` と `asking` の席と、`at` から 24 時間以内の `done` と `failed` の席を、`at` の新しい順に 5 件まで出す。1 行は件名、状態（動いている・判断待ち・`status`・失敗）、経過時間、要旨。日次 cron は、`at` から 7 日を過ぎた `done` と `failed` の席を消す。`started` と `asking` の席は、次の出来事が届くまで残る。

## 互換性

項目の名前の変更や削除、検証を厳しくする変更は、mizuya の Working を先に新旧どちらでも動くようにしてから Worker を変える。`event` と `status` の値を足すときは、Worker を先に変える。
