# プライバシー

yunomi は個人用の AI パートナーの実行環境で、このデプロイは持ち主が自分のために運用している。ほかの利用者には提供しない。

この文書は、yunomi が保存しているデータと、処理のために外部へ送るデータを並べたものである。保存先・内容・保持期間・削除手段をコードに合わせて書く。

## 前提

- Gateway は、Discord サーバーのテキストチャンネルの発言を、仕事カテゴリ（`WORK_CATEGORY_IDS`）を除いてすべて Worker に送る。持ち主以外の人の発言も含む。`WORK_CATEGORY_IDS` が未設定だと仕事カテゴリも除外されず、Gateway は起動時に警告を出す。
- VC では、持ち主（`OWNER_DISCORD_USER_ID`）の声だけを kukicha で文字にして Worker に送る。文字にした発言は、VC のテキストチャットにも書き込む。
- 下の表の「削除手段」で D1 への SQL とあるものは、持ち主が Wrangler（`wrangler d1 execute`）で行を消す。`ykm` と Admin API で消せるのは会話ログ（`conversation_messages`）だけである。会話ログを消すと、そこから作った記憶の索引（会話の塊、FTS5、Vectorize）からも消える。
- D1 や DO から消した行も、消す前に作られた Snapshot には残る。Snapshot は 30 日で消える。

## D1

| テーブル | 内容 | 保持期間 | 削除手段 |
| --- | --- | --- | --- |
| `audit_events` | 1 ターンごとの判断の記録。受信した発言の本文（`inbound_content`）、返事をしたか、モデル、token 数、道具の呼び出しの概要。返事をしなかったターンと、持ち主以外の人の発言も入る | 30 日。日次 cron が作成から 30 日を過ぎた行を消す | 自動。個別には D1 への SQL |
| `conversation_messages` | 返事をしたターンの会話の本文。受信した発言と、その前の文脈 10 件と、Partner の返事。発言者の Discord の ID と表示名を持つ。チャンネルにいた持ち主以外の人の発言も入る | 持ち主と Partner 自身の発言は無期限。それ以外の人の発言は、日次 cron が発言から 90 日を過ぎた行を消す。`OWNER_DISCORD_USER_ID` が無い環境では消さない | 自動。個別には `ykm maintenance conversation-log delete`（期間・チャンネル・メッセージ ID で指定）か Admin API の `POST .../conversation-log/delete` |
| `conversation_chunks`、`conversation_chunk_messages` | 記憶の索引に入れる会話の塊。持ち主の発言と、その前 30 分以内の持ち主と Partner の発言（最大 4 件）、続く Partner の返事の本文をまとめたものと、元の `conversation_messages` の ID。持ち主以外の人の発言は入れない。`OWNER_DISCORD_USER_ID` が無い環境では作らない | 元の発言が残る間。会話ログを消すと、塊を消すか残りの発言で作り直す | 会話ログの削除に追従する |
| `memory_search_docs`、`memory_search_fts` | キーワード検索（FTS5）の索引。現行の `facts`、`work_notes`、会話の塊の本文と、元の行の ID、partner、時刻 | 元の行が索引の対象である間。事実が置き換わるか期限が付くと外れる | 元の表の変更に trigger で追従する |
| `maintenance_events` | 記憶を消した操作の記録。種類、操作した主体（cron・持ち主・`ykm`）、消した件数、時刻。消した本文・条件・メッセージ ID は持たない | 無期限 | D1 への SQL |
| `audit_daily_kpis` | `audit_events` を消す前に生活日ごとに集計した件数・遅延・token 数。本文は持たない | 無期限 | D1 への SQL |
| `entities` | 発言した人の内部 ID と表示名 | 無期限 | D1 への SQL |
| `external_identities` | Discord の user ID と内部 ID の対応 | 無期限 | D1 への SQL |
| `facts` | 会話から覚えた事実と出来事（呼び名、好み、予定、行った所など）。置き換わった事実も履歴として残る | 無期限 | D1 への SQL。Snapshot の復元でも置き換わる |
| `memory_candidates` | 事実にする前の候補と、昇格・却下・衝突の判定結果 | 30 日。日次 cron が `expires_at` を過ぎた行を消す | 自動。個別には D1 への SQL |
| `open_loops` | 会話で出た、あとで気にかける事柄の 1 行の要約 | 無期限。解決しても行は残る | D1 への SQL |
| `relationship_events` | 人ごとの親しさ・信頼の変化と、その理由の 1 行 | 無期限 | D1 への SQL |
| `state_transitions` | Partner の気分・元気の変化の履歴 | 無期限 | D1 への SQL |
| `interest_states`、`opinion_states` | Partner の興味と意見の現在値と、その理由 | 無期限 | D1 への SQL |
| `interest_changes`、`opinion_changes` | 興味と意見の変化の履歴と、きっかけになったメッセージの ID | 無期限 | D1 への SQL |
| `work_notes` | Working（mizuya）が残した、決まったこと・終わったこと・目標の 1 行 | 無期限 | D1 への SQL |
| `watches` | 見張りの条件、見る先、前に知らせたものの key | 無期限。止めても行は残る | D1 への SQL |
| `partners` | Partner の ID | 無期限 | D1 への SQL |

## Durable Object（Partner ごと）

| テーブル・キー | 内容 | 保持期間 | 削除手段 |
| --- | --- | --- | --- |
| `recent_messages` | チャンネルごとの直近の発言の本文、発言者の ID と表示名。持ち主以外の人の発言も入る | チャンネルごとに新しい 30 件。書くたびに古いものを消す | 自動 |
| `processed_events` | 再送の判定に使う、処理済みのイベントのキーと応答（返事の本文を含む） | 7 日。書くたびに古いものを消す | 自動 |
| `pending_operations` | 持ち主の了承を待つ道具の操作と、その入力（予定の作成なら予定の件名・日時・説明） | 無期限。解決しても行は残る | なし |
| 声の送信待ち（storage のキー） | 声にする返事の本文と声の指定 | 送るか、2 分の期限を過ぎるまで | 自動 |
| `partner_state`、`relationships`、`channel_state`、`entity_cache`、`llm_health`、`voice_connection` | Partner の気分、人ごとの親しさ、チャンネルの最後の返事の時刻、ID の対応、LLM の失敗回数、接続中の VC | 現在値だけを持つ | Snapshot の復元で置き換わる |

## R2 の Snapshot

| 保存先 | 内容 | 保持期間 | 削除手段 |
| --- | --- | --- | --- |
| `snapshots/<partner>/` | `entities`、`external_identities`、`facts`、`memory_candidates`、`open_loops`、`interest_states`、`opinion_states`、`work_notes`、`watches` と、DO の `partner_state` と `relationships`。age の公開鍵で暗号化してある。会話の本文と `audit_events` は入れない | 30 日。日次 cron が作成から 30 日を過ぎたものを消す | 自動。個別には R2 のオブジェクトを消す |

prod の Snapshot は `ykm snapshot-seed` で dev に復元できる。復元した dev の D1 と DO にも同じ内容が入る。

## ログ

| 保存先 | 内容 | 保持期間 | 削除手段 |
| --- | --- | --- | --- |
| Worker のログ（Cloudflare） | エラーの種類、イベント ID、チャンネル ID、Discord の user ID、Snapshot の復元の件数。発言の本文は出さない | Cloudflare のログの保持期間 | なし |
| Gateway のログ（docker01 のコンテナ） | 接続、VC の発話の長さ、エラーの種類、guild とチャンネルの ID。発言の本文は出さない | コンテナのログの設定による | コンテナを作り直す |
| ochoko・kukicha のログ（GPU 機） | 呼び出し元、文字数、処理時間。本文は出さない | 各サービスの設定による | GPU 機でログを消す |

## 外部の処理先

| 処理先 | 送るもの | 用途 |
| --- | --- | --- |
| Anthropic（Claude API） | 人格の本文、チャンネルの直近の発言、覚えている事実と出来事、Working のメモ、気にかけている事柄、人ごとの関係、道具の結果、添付画像 | 返事をするかの判定と、返事の生成 |
| Workers AI（`@cf/baai/bge-m3`） | 索引に入れる現行の事実、Working のメモ、会話の塊の本文と、索引を引くときの手がかりの文 | 埋め込みの生成 |
| Vectorize | 埋め込みと、元の行の ID、partner、種類、時刻。本文は送らない | 話題に関係する記憶を探す索引。会話は持ち主と Partner の発言だけを入れる。事実の置き換え・期限、行の削除、会話ログの削除に追従して消える |
| ochoko（GPU 機） | 声にする返事の本文と声の指定 | 音声合成。合成した音声は Discord に添付する |
| kukicha（GPU 機） | VC で持ち主が話した音声 | 文字起こし。登録した持ち主の声以外は捨てる |
| mizuya の Working | 記憶の口（`docs/working-memory-api.md`）で、依頼した人の事実と出来事、気にかけている事柄、目標、見張り | Working が仕事の依頼に答える。Working は自分のモデルの呼び先にもこれを送る |
| 道具の呼び先（Google カレンダー、Google Places、GitHub、chatsumi、Home Assistant） | 道具の入力（検索語、予定の内容、URL など） | 道具の実行 |

データを売ったり、広告やモデルの学習に使ったりはしない。

## Google カレンダー

持ち主の同意を得て、Google Calendar API（スコープ `https://www.googleapis.com/auth/calendar.events`）で持ち主のカレンダーを使う。

- 指定された期間の予定を読み、会話で持ち主の質問に答える。
- 予定は、持ち主が会話で了承したときだけ作る。了承を待つ間、作る予定の内容を `pending_operations` に持つ。
- 読んだ予定は Anthropic に送り、返事に使う。Audit には期間と件数だけを残し、予定の件名や説明は残さない。返事に予定の内容が含まれた場合は、会話の本文として上の表のとおり残る。
- OAuth の refresh token は Cloudflare Worker の暗号化された secret に置く。

持ち主は Google アカウントの「サードパーティ製のアプリとサービス」（https://myaccount.google.com/connections）からいつでもアクセスを取り消せる。

## 連絡先

https://github.com/ochanuco/yunomi/issues に Issue を立てる。
