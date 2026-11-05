# apps/working

Working（仕事）を受け持つコンテナ。`orca serve`、Claude CLI、Working 受付を 1 つの Linux コンテナで動かし、仕事フォーラムの投稿ごとに Yukarin の人格で Claude CLI に作業させる。

## 中身

| ファイル | 役割 |
| --- | --- |
| `Dockerfile` | Debian に Orca の Linux 版（`orca-ide`）と Claude CLI を入れる。人格の元ファイルも入れる |
| `persona.sh` | `partners/yukarin` の `identity/*.md`・`profile.yaml`・`examples.yaml` を連結し、system prompt として標準出力に出す |
| `src/` | Working 受付（`@yunomi/working`）。gateway から envelope を受け、Discord REST と Claude CLI で作業する |
| `start.sh` | コンテナの entrypoint。受付と、引数で渡したコマンド（`orca-ide serve …`）を並べて動かし、どちらかが終わればコンテナを終わらせる |

Orca の Linux 版は GitHub Releases（`stablyai/orca`）の `orca-ide_<版>_<arch>.deb` を使う。CLI の名前は `orca` ではなく `orca-ide`。版は `ORCA_VERSION` で Mac の Orca と揃える。

## volume

| volume | マウント先 | 残るもの |
| --- | --- | --- |
| `yunomi-working-claude` | `/home/worker/.claude` | Claude CLI のログイン情報（`.credentials.json`）、設定（`.claude.json`）、セッション（`projects/`） |
| `yunomi-working-orca` | `/home/worker/.config` | orcad の本体と状態、pairing 済みの端末 |
| `yunomi-working-state` | `/home/worker/state` | フォーラム投稿とセッションの対応（`threads.json`）、組み立てた system prompt |

`CLAUDE_CONFIG_DIR` を `~/.claude` に向けているので、通常は `~/.claude.json` に置かれる設定も volume に入る。

## Working 受付

gateway が仕事カテゴリの発言を `POST /events` に送ってくる（`WORKING_URL` は `http://<host>:8080/events`）。`Authorization: Bearer <WORKING_TOKEN>` が合わなければ 401 で断る。受け取ったら 202 を返し、作業は後で進める。`GET /healthz` は生存確認用。

### 流れ

- 仕事テキストチャンネルで Yukarin 宛て（Yukarin か bot ロールへのメンション、Yukarin の発言への返信）の依頼が来たら、仕事フォーラムに投稿を立てる。件名は依頼の要約（Claude CLI の haiku で作り、失敗したら依頼の 1 行目）、本文は元の依頼と元メッセージへのリンク。テキストチャンネルには投稿へのリンクを返信で返す。
- 仕事フォーラムに人が直接投稿したときは、その投稿で作業を始める。
- 投稿内の返事は、投稿に対応するセッションに `claude -p --resume` で渡す。セッションが見つからなければ、投稿のやりとり（最大 100 件）を読ませて新しいセッションで続ける。
- 返事は同じ投稿に書く。同じ投稿への発言は 1 件ずつ順に処理する。
- `WORKING_OWNER_DISCORD_USER_IDS` に入っている人の発言だけを扱う。Yukarin 自身、ほかの人、ほかの bot の発言は、依頼・フォーラムの投稿・投稿内の返事のどれでも無視する。

### タグ

フォーラムに `決めてほしい`・`作業中`・`引き継ぎ`・`完了` のタグを作っておく。受付は名前で ID を引く。作業を始めるときに `作業中` を付け、返事の最後の行（`状態: …`、投稿には出さない）に合わせて付け替える。書かれていなければ `決めてほしい` にする。人が付けたほかのタグは残す。

### Claude CLI の権限

既定は読み取りだけ（`--tools Read,Glob,Grep --permission-mode dontAsk`）。`src/claude-cli.ts` の `ClaudePolicy` を差し替えて変える。作業ディレクトリは `WORK_DIR` に固定する（Claude CLI のセッションは作業ディレクトリに紐づく）。

### 環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `DISCORD_TOKEN` | はい | Yukarin の bot トークン。Discord REST に使う |
| `WORKING_TOKEN` | はい | gateway と共有するトークン |
| `WORK_TEXT_CHANNEL_ID` | はい | 依頼を受ける仕事テキストチャンネル |
| `WORK_FORUM_CHANNEL_ID` | はい | 投稿を立てる仕事フォーラム |
| `WORKING_OWNER_DISCORD_USER_IDS` | はい | 作業を頼める人の Discord ユーザー ID（カンマ区切り） |
| `PORT` | いいえ | 待ち受けるポート。既定は `8080` |
| `STATE_DIR` | いいえ | 対応表の置き場所。既定は `~/state` |
| `WORK_DIR` | いいえ | Claude CLI の作業ディレクトリ。既定は `~/work` |
| `PERSONA_SCRIPT` | いいえ | 人格を出力するスクリプト。既定は `~/bin/persona.sh` |
| `CLAUDE_BIN` | いいえ | Claude CLI のパス。既定は `claude` |
| `CLAUDE_TIMEOUT_MS` | いいえ | 1 回の作業の上限。既定は 30 分 |
| `LOG_LEVEL` | いいえ | `debug` / `info` / `warn` / `error`。既定は `info` |

bot には仕事フォーラムでの投稿の作成・メッセージ送信・スレッドの管理（タグの付け替え）と、メッセージ履歴を読む権限が要る。

## 試し方

リポジトリの root で行う。

```sh
docker build -f apps/working/Dockerfile -t yunomi-working:spike .

docker run -d --name working \
  -p 127.0.0.1:16768:6768 \
  -p 127.0.0.1:18080:8080 \
  --env-file .env.working \
  -v yunomi-working-claude:/home/worker/.claude \
  -v yunomi-working-orca:/home/worker/.config \
  -v yunomi-working-state:/home/worker/state \
  yunomi-working:spike \
  orca-ide serve --port 6768 --pairing-address 127.0.0.1:16768
```

Mac の Orca が 127.0.0.1:6768 を使っているため、ホスト側のポートは 6768 以外にする。6768 のままだと Mac の Orca 自身に繋がり、`4001: Unauthorized` で断られる。`--pairing-address` は Mac から届くアドレスにする。

### 1. Mac の Orca から接続する

```sh
code=$(docker logs working 2>&1 | grep '^Pairing URL:' | tail -1 | sed 's/^Pairing URL: //')
orca environment add --name working --pairing-code "$code"
orca status --environment working   # runtimeConnectionState: connected
```

pairing のコードは端末の認証情報なので、ログや Issue に貼らない。

### 2. Claude CLI にログインする

```sh
docker exec -it working claude   # /login で表示された URL を開いて承認し、/exit
docker exec working claude auth status
```

### 3. Yukarin の人格で答えさせる

```sh
docker exec working bash -c '
~/bin/persona.sh > /tmp/persona.md
claude -p --system-prompt-file /tmp/persona.md --output-format json "はじめまして。好きな飲み物は焙じ茶です" \
  | jq -r ".session_id, .result"'
```

### 4. 続きから答えさせる

3 で出た `session_id` を渡す。

```sh
docker exec working bash -c '
~/bin/persona.sh > /tmp/persona.md
claude -p --resume <session_id> --system-prompt-file /tmp/persona.md "私の好きな飲み物は何でしたっけ？"'
```

`docker rm -f working` で作り直してから同じことをしても、ログイン・セッション・pairing・投稿との対応は volume に残る。

`.env.working` には上の環境変数を書く（commit しない）。受付は起動時に Discord に接続できなければ終了し、コンテナも一緒に終わる。
