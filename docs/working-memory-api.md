# 記憶の口（Working memory API）

Talking と同じ記憶を、yunomi の外のクライアントが読み書きするための HTTP API。今のクライアントは [ochanuco/mizuya](https://github.com/ochanuco/mizuya) の Working（`apps/working`。席の CLI `yunomi-memory` と受付）だけ。

記憶の正本は yunomi の Worker（D1）にある。この口は Partner DO の turn を通さず D1 だけを触るので、関係性・状態・興味・意見・直近の会話履歴は動かない。

## 接続

| 項目 | 値 |
| --- | --- |
| URL | `<Worker の URL>/v1/partners/:partnerId/working/memory` |
| `partnerId` | `yukarin` か `akarin`。ほかは 404 `unknown_partner` |
| 認証 | Cloudflare Access の service token。`CF-Access-Client-Id` と `CF-Access-Client-Secret` を付ける。Worker は Access の JWT の `common_name` を `accessCallers` で引き、`working` に引かれた token だけを通す |
| 本文 | JSON（`Content-Type: application/json`） |

認証に失敗すると 401、`working` でない呼び手は 403 `forbidden`。

## 相手の指定

すべての要求は、記憶の持ち主を Discord の user ID（`discord_user_id`）で指す。Talking で話したことのある相手の entity だけを引き、無ければ 404 `unknown_entity`。この口は entity を作らない。

## 失敗の形

```json
{ "error": "<種類>", "message": "<理由（あれば）>" }
```

| status | `error` | いつ |
| --- | --- | --- |
| 400 | `validation_failed` | 本文やクエリが下の形に合わない。`message` に理由 |
| 404 | `unknown_partner` / `unknown_entity` / `unknown_goal` / `unknown_watch` | 対象が無い |
| 405 | `method_not_allowed` | GET・POST・PATCH 以外 |
| 409 | `duplicate_goal` / `goal_limit` / `duplicate_watch` / `watch_limit` | 重複か上限 |

## GET: 読む

`GET ?discord_user_id=<ID>`

Talking の prompt と同じ選び方と順で返す。時刻はすべて `YYYY-MM-DD HH:mm JST`。

```json
{
  "facts": [{ "predicate": "...", "object": "...", "observed_at": "..." }],
  "episodes": [{ "predicate": "...", "object": "...", "observed_at": "..." }],
  "open_loops": [{ "id": "...", "summary": "...", "due_at": "... | null" }],
  "goals": [{ "id": "...", "summary": "...", "created_at": "..." }],
  "watches": [{
    "id": "...", "query": "...", "sources": ["..."],
    "interval_minutes": 360, "until_at": "... | null", "last_checked_at": "... | null",
    "due": true, "seen": ["..."], "notify_thread_id": "... | null"
  }]
}
```

- `facts` は続く事実、`episodes` はできごと（仕事で残した 1 行を含む）。どちらも保持率（忘却曲線の R）の高い順。
- `goals` は open な目標を古い順に全件。
- `watches` は動いている見張り（期限切れを除く）を古い順に全件。`due` は前に調べてから間隔が過ぎたか、まだ調べていないか。`seen` は前に知らせたものの key。`notify_thread_id` は新着を書く Discord の投稿。

## POST: 残す

### 決まったこと・終わったこと・目標

```json
{ "discord_user_id": "...", "kind": "decided | done | goal", "summary": "<1 行>" }
```

- `summary` は改行なし、前後の空白を除いて 200 字まで。Talking の記憶では 1 件が 1 行に並ぶため。
- 201 で `{ id, kind, summary, created_at }` を返す。
- `goal` は open で入る。同じ文面の open な目標があれば 409 `duplicate_goal`、open な目標が 10 件あれば 409 `goal_limit`。
- `decided` と `done` は、Talking の prompt で保持率（忘却曲線の R）の高い 10 件が「仕事で決めたこと」「仕事で終えたこと」の出来事として出る。

### 見張り

```json
{
  "discord_user_id": "...",
  "watch": { "query": "...", "sources": ["..."], "interval_hours": 6, "until": "2026-12-31T23:59:00+09:00" },
  "notify_thread_id": "<数字だけ。省略可>"
}
```

- `watch` は Talking の道具 `watch_add` と同じ検証を通す。`query` は改行なしの 200 字まで、`sources` は 1 件 300 字まで 5 件まで（省くと普通の検索）、`interval_hours` は 1 〜 168 の整数（省くと 24）、`until` はタイムゾーン付きの ISO 8601（省くと期限なし、過去は不可）。通らなければ 400 `validation_failed`。
- 同じ `query` の見張りがあれば 409 `duplicate_watch`、動いている見張りが 10 件あれば 409 `watch_limit`。
- 201 で `{ id, query, sources, interval_minutes, until_at }` を返す。

## PATCH: 閉じる・止める・調べ終える

| 本文 | すること | 応答 |
| --- | --- | --- |
| `{ discord_user_id, id, status: "achieved" \| "dropped" }` | open な目標を閉じる。無ければ 404 `unknown_goal` | `{ id, summary, status }` |
| `{ discord_user_id, watch_id, status: "stopped" }` | 動いている見張りを止める。無ければ 404 `unknown_watch` | `{ id, query, stopped: true }` |
| `{ discord_user_id, watch_id, seen: [...] }` | 見張りを調べ終えた。前に調べた時刻を今にし、`seen` の key（1 件 200 字まで、100 件まで）を重ねずに足す。覚えるのは新しい 100 件まで。無ければ 404 `unknown_watch` | `{ id, checked: true }` |

## 互換性

項目の名前の変更や削除、検証を厳しくする変更は、mizuya の Working（`apps/working/src/memory-cli/` と受付）を先に新旧どちらでも動くようにしてから Worker を変える。
