# apps/working

Working（仕事）を受け持つコンテナ。`orca serve`、Claude CLI、Working 受付を 1 つの Linux コンテナで動かし、仕事フォーラムの投稿ごとに Yukarin の人格で Claude CLI に作業させる。

## 中身

| ファイル | 役割 |
| --- | --- |
| `Dockerfile` | Debian に Orca の Linux 版（`orca-ide`）、Claude CLI、`gh` を入れる。人格の元ファイル、引き継ぎの指示、取り消せない操作を止める hook も入れる |
| `persona.sh` | `partners/yukarin` の `identity/*.md`・`profile.yaml`・`examples.yaml` を連結し、system prompt として標準出力に出す |
| `compose.example.yaml` | 常駐させるときの compose の雛形 |
| `src/` | Working 受付（`@yunomi/working`）。gateway から envelope を受け、Discord REST と Claude CLI で作業する |
| `src/guard/` | Claude CLI の PreToolUse hook。道具を使う前に、聞かずに実行してよいかを決める。node の組み込みだけで書き、`/opt/yunomi-guard/` に置いて node で直接動かす |
| `guard/managed-settings.json` | hook を登録する Claude CLI の managed settings。`/etc/claude-code/` に置く |
| `start.sh` | コンテナの entrypoint。受付と、引数で渡したコマンド（`orca-ide serve …`）を並べて動かし、どちらかが終わればコンテナを終わらせる |

Orca の Linux 版は GitHub Releases（`stablyai/orca`）の `orca-ide_<版>_<arch>.deb` を使う。CLI の名前は `orca` ではなく `orca-ide`。版は `ORCA_VERSION` で Mac の Orca と揃える。

## volume

| volume | マウント先 | 残るもの |
| --- | --- | --- |
| `yunomi-working-claude` | `/home/worker/.claude` | Claude CLI のログイン情報（`.credentials.json`）、設定（`.claude.json`）、セッション（`projects/`） |
| `yunomi-working-orca` | `/home/worker/.config` | orcad の本体と状態、pairing 済みの端末 |
| `yunomi-working-state` | `/home/worker/state` | フォーラム投稿とセッションの対応（`threads.json`）、許可を待っている操作（`approvals.json`）、止めた操作と許可の記録（`guard/`）、組み立てた system prompt |
| `yunomi-working-work` | `/home/worker/work` | Claude CLI の作業場所。clone したリポジトリ |

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

### system prompt

起動時に、`persona.sh` の出力、仕事のしかた（`src/prompts.ts` の `WORKING_INSTRUCTIONS`）、Mac への引き継ぎの手順（`handoff/prompt.md`）、申し送りの雛形（`handoff/issue-template.md`）の順に連結して `STATE_DIR/system-prompt.md` に書く。

### Claude CLI の権限

Claude CLI には `Read`・`Glob`・`Grep`・`Edit`・`Write`・`Bash` を渡し（`--permission-mode dontAsk --setting-sources ""`）、使うたびに managed settings の PreToolUse hook（`src/guard/hook.ts`）が通すかどうかを決める。allow のルールは置かないので、hook が落ちたときは dontAsk が断る。managed settings と hook は root の持ち物にし、作業場所の `.claude/settings.json` や Claude CLI 自身の書き換えでは外せない。

作業ディレクトリは `WORK_DIR` に固定する（Claude CLI のセッションは作業ディレクトリに紐づく）。Claude CLI に渡す環境変数は `src/claude-cli.ts` の `claudeEnv` に絞り、Discord のトークンと `WORKING_TOKEN` は渡さない。

聞かずに通す操作:

- 読み取り（秘密情報や設定・許可の記録がある場所を除く）
- 作業場所の中のファイルの編集と削除、テストやビルドの実行
- `git commit`、`origin` の `dev/` で始まるブランチへの push（押し先を `HEAD:dev/<topic>` のように書いたもの）
- `gh issue create` / `comment`、`gh pr create` / `comment`、`gh label create`（申し送りに使う）と、`gh` の読み取り

止める操作:

- `dev/` 以外への push、押し先を書いていない push、force push、まとめての push、ブランチの削除
- `gh pr merge`・`gh api`・`gh repo delete`・`gh release` など、上で通す以外の `gh`
- 作業場所の外の削除と移動、作業場所の外（`/tmp` を除く）への書き込み
- デプロイ・公開・課金・外部のサービスに届く道具（`wrangler`、`pnpm deploy`、`npm publish`、`tofu`、`stripe` など）、`curl` の POST などの送信
- 秘密情報の読み出し（`printenv`、トークンの変数、`~/.claude`・`~/.config`・`STATE_DIR` など）
- 中身を読めない実行（`bash -c`、`eval`、`node -e`、パイプからの `sh`）

Bash は道具の名前と引数で読むので、書き方を変えれば抜けられる。うっかりの実行を止めるためのもので、`main` への push やマージは GitHub のブランチ保護とトークンの権限でも止めておく。

### 取り消せない操作の許可

1. hook が止めた操作は `STATE_DIR/guard/pending/` に残る。受付は 1 回の作業が終わるとそれを取り出し、Claude CLI の返事に続けて「決めてほしいこと」としてコマンドそのものを投稿に書き、タグを `決めてほしい` にする。
2. 持ち主がその投稿に `OK`・`許可`・`許可します` のどれか（全角・末尾の句点は許す）だけを返すと許可になる。返信の形で送るときは「決めてほしいこと」のメッセージへの返信にする。ほかの返事が来たら、待っていた操作は取りやめる。
3. 許可すると、受付はその操作を環境変数で Claude CLI に渡して resume する。hook は同じ道具・同じ内容の操作を 1 回だけ通す。その回で使わなかった許可は失効し、次に同じ操作をするとまた止まる。

止めた・聞いた・許可した・使った・失効した・取りやめたの記録は `STATE_DIR/guard/log.jsonl` に 1 行ずつ残る。

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
| `HANDOFF_DIR` | いいえ | `prompt.md` と `issue-template.md` の置き場所。既定は `~/handoff` |
| `GH_TOKEN` | いいえ | Claude CLI の `gh` と `git push` が使う書き込みトークン |
| `GIT_AUTHOR_NAME` など | いいえ | Claude CLI の commit の作者。`GIT_AUTHOR_*` と `GIT_COMMITTER_*` を渡す |
| `YUNOMI_URL` | いいえ | Worker の URL。Claude CLI が Working の記憶の口（`/v1/partners/:partnerId/working/memory`）を呼ぶ |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | いいえ | Working 用の Access service token。Worker の `accessCallers` で `working` に引かれる |
| `CLAUDE_BIN` | いいえ | Claude CLI のパス。既定は `claude` |
| `CLAUDE_TIMEOUT_MS` | いいえ | 1 回の作業の上限。既定は 30 分 |
| `LOG_LEVEL` | いいえ | `debug` / `info` / `warn` / `error`。既定は `info` |

bot には仕事フォーラムでの投稿の作成・メッセージ送信・スレッドの管理（タグの付け替え）と、メッセージ履歴を読む権限が要る。

## 配備

main への push で `.github/workflows/working-image.yml` が `ghcr.io/ochanuco/yunomi-working:main` と `:sha-<short>` を公開する。PR ではビルドだけ確かめる。

gateway と同じホストに、gateway とは別の compose project で置く（`compose.example.yaml`）。gateway を更新しても Working の作業は止まらない。

- 受付は docker0 のゲートウェイ（`172.17.0.1:8180`）にだけ公開する。gateway は `extra_hosts: host.docker.internal:host-gateway` を足し、`WORKING_URL=http://host.docker.internal:8180/events` で送る。
- `restart: unless-stopped` で、ホストの再起動後も受付と `orca serve` が上がる。
- volume は 4 つ（上の表）。コンテナを作り直しても、ログイン・pairing・投稿との対応・作業用の clone が残る。

### 初回だけ人が行うこと

#### Claude CLI のログイン

```sh
docker exec -it <コンテナ名> claude   # /login で表示された URL を開いて承認し、/exit
docker exec <コンテナ名> claude auth status
```

ログイン情報は `yunomi-working-claude` の volume に残る。期限が切れたら同じ手順でやり直す。

#### Mac の Orca との pairing

`--pairing-address` は Mac から届くホストのアドレスとポートにする。コンテナのログに出る pairing URL を Mac の Orca に渡す。

```sh
code=$(docker logs <コンテナ名> 2>&1 | grep '^Pairing URL:' | tail -1 | sed 's/^Pairing URL: //')
orca environment add --name working --pairing-code "$code"   # Mac で実行する
orca status --environment working   # runtimeConnectionState: connected
```

pairing のコードは端末の認証情報なので、ログや Issue に貼らない。pairing 済みの端末は `yunomi-working-orca` の volume に残る。

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
  -v yunomi-working-work:/home/worker/work \
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
