# apps/working

Working（仕事）を受け持つコンテナ。`orca serve`、Claude CLI、Working 受付を 1 つの Linux コンテナで動かす。仕事フォーラムの投稿 1 件に Orca の席（worktree と、そこに居続ける Claude CLI）を 1 つ付け、Yukarin の人格で作業させる。受付は Claude を自分で起動せず、Discord と Orca（`orca-ide orchestration`）の間で言葉を運ぶ。

## 中身

| ファイル | 役割 |
| --- | --- |
| `Dockerfile` | Debian に Orca の Linux 版（`orca-ide`）、Claude CLI、`gh`、mise と依存のビルドに要る OS のパッケージを入れる。人格の元ファイル、引き継ぎの指示、取り消せない操作を止める hook も入れる |
| `mise/config.toml` | 席の既定の道具（node、pnpm、uv、jq）。`/etc/mise/config.toml` に置く |
| `persona.sh` | `partners/yukarin` の `identity/*.md`・`profile.yaml`・`examples.yaml` を連結し、席の Claude に渡す人格として標準出力に出す |
| `compose.example.yaml` | 常駐させるときの compose の雛形 |
| `src/` | Working 受付（`@yunomi/working`）。gateway から envelope を受け、Discord REST と Orca の席で作業する |
| `src/memory-cli/` | 記憶の道具 `yunomi-memory`。Worker の Working の記憶の口を読み書きする。node の組み込みだけで書き、`/opt/yunomi-memory/` に置いて node で直接動かす |
| `mac-state/` | Mac から Orca の席の状態を送るスクリプトと launchd の plist の雛形（[mac-state/README.md](mac-state/README.md)） |
| `src/guard/` | Claude CLI の PreToolUse hook。道具を使う前に、聞かずに実行してよいかを決める。node の組み込みだけで書き、`/opt/yunomi-guard/` に置いて node で直接動かす |
| `guard/managed-settings.json` | hook を登録する Claude CLI の managed settings。`/etc/claude-code/` に置く |
| `start.sh` | コンテナの entrypoint。受付と、引数で渡したコマンド（`orca-ide serve …`）を並べて動かし、どちらかが終わればコンテナを終わらせる |
| `seat-env.sh` | start.sh が `orca-ide serve` をこれ越しに起動する。席の Claude は orca serve の環境変数を受け継ぐので、渡してよい変数だけに絞る |
| `release-orcad-lock.sh` | `orca-ide serve` の前に start.sh が呼ぶ。前のコンテナの orcad が volume に残した `orcad.lock` を消す |

Orca の Linux 版は GitHub Releases（`stablyai/orca`）の `orca-ide_<版>_<arch>.deb` を使う。CLI の名前は `orca-ide` で、席の Claude が読む手順書が `orca` と書くので `/usr/local/bin/orca` を同じものに向けてある。版は `ORCA_VERSION` で Mac の Orca と揃える。

## volume

| volume | マウント先 | 残るもの |
| --- | --- | --- |
| `yunomi-working-claude` | `/home/worker/.claude` | Claude CLI のログイン情報（`.credentials.json`）、設定（`.claude.json`）、セッション（`projects/`） |
| `yunomi-working-orca` | `/home/worker/.config` | orcad の本体と状態、pairing 済みの端末 |
| `yunomi-working-state` | `/home/worker/state` | フォーラム投稿と席の対応、Orca の Run と受付の端末（`seats.json`）、許可を待っている操作（`approvals.json`）、止めた操作と許可の記録（`guard/`）、最後に届いた Mac の席の状態（`mac-state.json`）、記憶の口の接続情報（`memory-credentials.json`） |
| `yunomi-working-work` | `/home/worker/work` | 席の元にする空の git リポジトリ（`seats/`）と、席の worktree（`orca/workspaces/seats/seat-<投稿の ID>/`）。席の Claude はその中に clone する。mise が入れた道具（`.mise/`）、pnpm の store（`.pnpm-store/`）、uv のキャッシュと Python（`.cache/uv/`・`.uv/`） |

`CLAUDE_CONFIG_DIR` を `~/.claude` に向けているので、通常は `~/.claude.json` に置かれる設定も volume に入る。Orca は worktree を `~/orca/workspaces` に作るので、`~/orca` は `~/work/orca` への symlink にしてある。

## Working 受付

gateway が仕事カテゴリの発言を `POST /events` に送ってくる（`WORKING_URL` は `http://<host>:8080/events`）。`Authorization: Bearer <WORKING_TOKEN>` が合わなければ 401 で断る。受け取ったら 202 を返し、作業は後で進める。`GET /healthz` は生存確認用。

### 流れ

| 投稿で起きること | 受付がやること |
| --- | --- |
| 新しい投稿（仕事チャンネルの依頼から立てたものも） | 席を作り（`worker-start`）、依頼を渡す。タグは `作業中` |
| 投稿への返事 | その席に渡す（`send`）。作業中なら席のターンの終わりに届く |
| 席の質問（`ask`）、取り消せない操作で止まったとき | 投稿に書いてタグを `決めてほしい` にし、返事を答えとして返す（`reply`） |
| 席の途中経過（`send --type status`） | そのまま投稿に書く。状態とタグは変えない |
| 席が裏の作業を待っている間に投稿に書く | すぐ「作業中です。（最後の途中経過）」と返し、書き込みは席に渡す |
| 席の返事（`ask`・`worker_done`・`status`）に `添付:` や `chimera:` の行がある | 行を本文から外し、席のファイルや chimera の元の画像を投稿に付ける |
| 投稿に「起動し直して」と書く | 席の Claude を止め、同じ worktree で `--continue` で起こす（コネクタの認証を足したあとなどに使う） |
| 席の完了報告（`worker_done`） | 投稿に書いてタグを `完了` にし、記憶に 1 行残し、席を閉じる |
| 完了のあとにまた書く | 同じ投稿に新しい席を作り、これまでのやりとり（最大 100 件）を渡す |
| Mac でやる必要がある | 席が申し送り issue を書いて報告する。タグを `引き継ぎ` にし、席を閉じる |

- 仕事テキストチャンネルで Yukarin 宛て（Yukarin か bot ロールへのメンション、Yukarin の発言への返信）の依頼が来たら、仕事フォーラムに投稿を立てる。件名は依頼の要約（Claude CLI の haiku で作る。前置きやメタ発言、複数行、40 字超の出力は使わず、依頼の 1 行目にする）、本文は元の依頼と元メッセージへのリンク。テキストチャンネルには投稿へのリンクを返信で返す。
- 同じ投稿への発言と席からのメッセージは、1 件ずつ順に処理する。
- Discord REST が 2xx 以外を返したときは、経路・ステータス・Discord のエラーコードとメッセージを warn で残す。bot の権限不足（403 の Missing Access / Missing Permissions）は `PermissionDenied` として扱う。
- `WORKING_OWNER_DISCORD_USER_IDS` に入っている人の発言だけを扱う。Yukarin 自身、ほかの人、ほかの bot の発言は、依頼・フォーラムの投稿・投稿内の返事のどれでも無視する。

### 席

- 受付は起動時に、`SEATS_REPO`（既定は `~/work/seats`）に空の git リポジトリを用意して Orca に登録し、その root に受付の端末（`受付`、中身は `sleep infinity`）を作る。orchestration の送り手と受け手はこの端末になる。Run は `seats.json` に残し、作り直した端末で引き継ぐ（`run-use`）。
- 席は投稿ごとに作る。`worktree create` で `seat-<投稿の ID>` の worktree を作り、その realpath を Claude CLI の信頼済みの場所（`.claude.json` の `projects[<realpath>].hasTrustDialogAccepted`）に登録してから、その worktree に `claude --permission-mode auto` の端末を作り、15 秒待ってから `worker-start --terminal` で依頼を渡す。待つのは、claude.ai のコネクタ（chimera など）が Claude の起動から遅れて読み込まれ、すぐに渡すと最初のターンに間に合わないため。信頼していない場所の Claude は確認の画面で止まり、Orca は席を始めない。登録は Claude CLI と同じ `.claude.json.lock` のロックを取って書くので、動いている席の Claude の書き込みと混ざらない。10 秒より古いロック（落ちたプロセスの残り）は外して進む。hook は worktree の名前から投稿を引く。Mac の Orca から接続すると、同じ席と Claude の画面が見える。
- 席を始められなかったときは、止まった所（作業場所の確認、Claude の起動、Orca の席の作成など）を短く投稿に書く。
- 受付は `orchestration check --wait` で席からのメッセージを待ち続ける。受付が落ちている間に届いたものも、次に起動したときに受け取る。
- 席の Claude が `worker_done` を送らずにターンを終えたとき、Orca の知らせ（escalation）に付く端末の末尾に裏で動いている shell やタスク（「1 shell still running」など）が出ていれば、待っているだけとみなして投稿に書かない。それ以外は「作業が途中で止まりました」と書いて `決めてほしい` にする。
- 裏の作業を待っている席の投稿に持ち主が書くと、受付はすぐ「作業中です。（いまやっていること）」と返す。いまやっていることは席の Claude が最後に送った途中経過（`status`）で、改行を詰めて 200 字で切る。無ければ「作業中です。」だけにする。書き込みは、手が空いたら `status` で答えるよう添えて席に渡す。席が質問か報告を送るか、裏の作業なしでターンを終えるまで、この即答を続ける。
- 「起動し直して」「再起動して」（全角・末尾の句点は許す）だけの返事は、席の Claude への返事にせず起動し直す。席が無ければふつうの返事として扱う。
- 同時に Claude を動かしておく席は `SEAT_LIMIT`（既定は 6）まで。上限を超えた投稿には「順番待ち」と書き、空いたら古い順に始める。止めた席と順番待ちの席は数えない。
- `決めてほしい` のまま `SEAT_SLEEP_AFTER_MINUTES`（既定は 120 分）たった席は、Claude だけ止める（worktree と会話は残す）。返事が来たら、その worktree で `claude --permission-mode auto --continue` の端末を作って `worker-start --terminal` で渡し、前の会話のまま起こす。
- 席を閉じるときは、席の Claude を止め、worktree を消す。席の Claude には、完了にする前に commit と push を済ませるよう指示してある。
- 起動時に `seats.json` と Orca の席を突き合わせる。対応表に無い席の端末と worktree（前回の残り）は片付け、対応表にある席は残す。Claude がいなくなっていた席は止めた扱いにし、作業中だったなら投稿で知らせて `決めてほしい` にする。

### タグ

フォーラムに `決めてほしい`・`作業中`・`引き継ぎ`・`完了` のタグを作っておく。受付は名前で ID を引く。席を作るときと席に返事を渡すときに `作業中` を付け、席の質問で `決めてほしい` にする。完了報告では本文の最後の行（`状態: …`、投稿には出さない）に合わせて付け替え、書かれていなければ `決めてほしい` にする。人が付けたほかのタグは残す。

### 席の Claude に渡すもの

新しい席の spec は、`persona.sh` の出力、仕事のしかた（`src/prompts.ts` の `WORKING_INSTRUCTIONS`）、Mac への引き継ぎの手順（`handoff/prompt.md`）、申し送りの雛形（`handoff/issue-template.md`）を連結した前置きに、投稿で頼まれたこと（完了のあとなら投稿のこれまでのやりとり）を続けたもの。Orca は orchestration の手順書を spec の前に足す。

仕事のしかたには、投稿への返事は `worker_done` の本文に書くこと、途中で聞きたいことは `ask` で聞くこと、本文の最後の行に状態を書くことを入れてある。

### 席の返事の添付

席の Claude が `ask`・`worker_done`・`status` の本文に次の行を書くと、受付は行を本文から外し、ファイルを投稿のメッセージに付ける。コードブロックの中の行は本文のまま残す。`worker_done` の状態の行は、添付の行を外したあとの最後の行として読む。

| 行 | 付けるもの |
| --- | --- |
| `添付: out/<ファイル名>` | 席の worktree の直下の `out/` にあるファイル |
| `chimera: <short_id>` | chimera の `/g/<short_id>/image` から取った元の PNG |

- `out/` の外のパス（絶対パス、`..` で外に出るもの）と、実体が worktree の `out/` の外にあるシンボリックリンクは付けない。
- Discord の上限（1 件に 10 個、1 ファイル 10 MB、1 件の合計 24 MB）を超えるもの、無いファイル、取れなかった画像は付けず、本文の最後に「添付できなかったもの」として理由と一緒に書く。同じ名前のファイルには番号を付ける。
- chimera は Cloudflare Access の後ろにある。受付は `CHIMERA_ACCESS_CLIENT_ID` / `CHIMERA_ACCESS_CLIENT_SECRET` を `CF-Access-Client-Id` / `CF-Access-Client-Secret` に載せ、User-Agent（`yunomi-working/1.0`）を明示して取る。転送（Access のログイン画面）や画像でない応答は失敗として扱う。`CHIMERA_URL` と service token のどれかが欠けていれば、`chimera:` の行は「受付に chimera の設定が無い」と書く。
- 使い方は `WORKING_INSTRUCTIONS` に書いてある（chimera で描いたら short_id を返事に書く）。

### 席の Claude の権限

席の Claude は、持ち主が手元で使うセッションと同じく Claude Code の auto モード（`--permission-mode auto`）で動く。取り消せない操作や外に出る操作を止めるかは、Claude Code の自動の判定が決める。席に話しかけられるのは持ち主だけ（`WORKING_OWNER_DISCORD_USER_IDS`）なので、投稿で明示的に頼んだ操作は持ち主の意思として扱われ、main への push やマージも聞かずに実行される。`main` への push やマージを止めたいときは、GitHub のブランチ保護とトークンの権限で止める。

managed settings（`/etc/claude-code/managed-settings.json`、root の持ち物）で次を決める。作業場所の `.claude/settings.json` や Claude CLI 自身の書き換えでは外せない。

- PreToolUse hook（`src/guard/hook.ts`）: 秘密情報の読み出し（`printenv`、トークンの変数、`gh auth token`、`~/.claude`・`~/.config`・`STATE_DIR`・`.credentials.json` など）と、秘密情報や許可の記録の場所への書き込みを止める。持ち主が投稿で許可した操作は、auto モードの判定によらず 1 回だけ通す。それ以外は何も返さず auto モードに任せる。
- PermissionDenied hook（同じ `hook.ts`）: auto モードが止めた操作を、その投稿に紐づけて記録する。受付が質問に書き添える。
- `ENABLE_TOOL_SEARCH=false`: MCP の道具を遅延読み込みせず、最初から読み込む。席の Claude は `ToolSearch` を使わずに chimera などの道具を呼べる。

hook は席の場所（`CLAUDE_PROJECT_DIR`）で、止めた操作の紐づけ先をその投稿にする。

席の Claude は `orca-ide serve` の環境変数を受け継ぐ。start.sh は `seat-env.sh` で、`HOME`・`PATH`・`GH_TOKEN`・`GIT_AUTHOR_*` / `GIT_COMMITTER_*` などと、hook が使う `YUNOMI_STATE_DIR`・`YUNOMI_SEATS_DIR`、mise・uv・pnpm の置き場所だけを渡して起動する。Discord のトークン、`WORKING_TOKEN`、`MAC_STATE_TOKEN`、記憶の口と chimera の service token は渡さない。

### 席のビルドとテスト

席の `PATH` の先頭には mise の shims（`~/work/.mise/shims`）がある。clone したリポジトリで `mise install` を実行すると、そのリポジトリの `mise.toml`（または `.tool-versions`）の道具と、`/etc/mise/config.toml` の既定の道具（node 24、pnpm 10、uv、jq）が入る。`mise.toml` を持たないリポジトリでも既定の道具で `pnpm install` や `uv sync` を回せる。

- 道具とダウンロードのキャッシュは work の volume に置くので、コンテナを作り直しても入れ直さない。
- `~/work` の下の `mise.toml` は信頼済みとして扱う（`MISE_TRUSTED_CONFIG_PATHS`）。`mise trust` は要らない。
- C 拡張や node-gyp のビルドに使う `build-essential`・`python3`・`pkg-config` と、opencv-python が読む `libgl1`・`libglib2.0-0` を入れてある。
- 受付（start.sh が起動する node）の `PATH` には shims を足さない。受付はイメージの node 24 で動く。

### 記憶の道具

席の Claude は `yunomi-memory` で、Talking と共有する長い記憶を読み書きする。受付も、席が完了したときと Mac に引き継いだときに 1 行残す。決まったことと終わったことは、そのつど 1 件 1 行ずつ残すよう `WORKING_INSTRUCTIONS` に書いてある。

```sh
yunomi-memory read                                         # 事実・出来事・open loop を JSON で出す
yunomi-memory write --kind decided --summary "<1行の要約>"  # 決まったこと
yunomi-memory write --kind done --summary "<1行の要約>"     # 終わったこと
```

- 呼ぶ先は Worker の `/v1/partners/yukarin/working/memory`。記憶の持ち主は `WORKING_OWNER_DISCORD_USER_IDS` の先頭の人。
- 受付は起動時に `YUNOMI_URL` と `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を `STATE_DIR/memory-credentials.json`（権限 600）に書き、`yunomi-memory` はそこから読む。service token は席の Claude の環境変数に載せず、標準出力にも標準エラーにも出さない。3 つのどれかが欠けていれば、ファイルを消して記憶の道具を使えなくする。
- `summary` は改行を含まない 200 字以内。

### 席の状態の受け口

Mac の Orca の worktree と agent の一覧を、`MAC_STATE_PORT`（既定は `8090`）の `POST /mac-state` で受ける。`MAC_STATE_TOKEN` を設定したときだけ待ち受ける。

- `Authorization: Bearer <MAC_STATE_TOKEN>` が合わなければ 401。gateway と共有する `WORKING_TOKEN` とは別のトークンにする。
- 本文は `mac-state/send.sh` が作る要約（`sent_at` と `worktrees`）。形が違えば 400。
- 受け取った最新の 1 件を、受け取った時刻と一緒に `STATE_DIR/mac-state.json` に置き換えて残す。Mac が寝ていても、朝会は最後に届いたものを読む。

### 朝会

受付は平日（月〜金、祝日は見ない）の `STANDUP_TIME`（既定は `09:00`、Asia/Tokyo）に朝会をする。`STANDUP_ENABLED=false` で止める。

1. 材料を集める。記憶（`yunomi-memory read`）、最後に届いた席の状態と届いた時刻、GitHub（`STANDUP_GITHUB_OWNER` の open な PR、CI が落ちている PR、label `working-handoff` の申し送り、`GH_TOKEN` の人が `dev/` ブランチから出した PR）、Claude CLI のログインの期限（`claude auth status` の `loginExpiresAt`）。取れなかったものは、取れなかったと書いて渡す。
2. ログインの期限が 7 日以内なら、席の返事を待たずに 1 件投稿する。
3. 朝会の席（`seat-standup-<ID>`）を作って材料を渡す。席の Claude は取り消せること（調べる、コメントする、`dev/` ブランチで直す、記憶に残す）をその場で済ませ、決めてほしいことだけを `worker_done` の本文に JSON で返す。朝会の席は持ち主に聞かない（`ask` には受付が「聞けない」と答える）。上限の数には入れず、決めてほしいままでも止めない。
4. 決めてほしいこと 1 件ごとに、仕事フォーラムへ投稿を立ててタグ `決めてほしい` を付ける。hook が止めた操作があれば 1 件の投稿にまとめ、その投稿で許可を待つ。朝会の席は報告を受けたら閉じる。
5. 決めてほしいことが無ければ何も投稿しない。

朝会の投稿に返事をすると、その投稿に新しい席を作り、投稿の本文と返事を渡して続ける。

朝会の始まり・終わり（決めてほしいことの件数、立てた投稿、投稿に失敗した数）と、材料を取れなかったことはログに残る。

### 取り消せない操作の許可

1. hook と auto モードが止めた操作は `STATE_DIR/guard/pending/` に投稿ごとに残る。席の Claude は止められると `ask` で許可を求める。受付は席から質問か報告が届くとそれを取り出し、席の言葉に続けて「決めてほしいこと」としてコマンドそのものを投稿に書き、タグを `決めてほしい` にする。止めた操作が残っていれば、完了の報告でも完了にしない。
2. 持ち主がその投稿に `OK`・`許可`・`許可します` のどれか（全角・末尾の句点は許す）だけを返すと許可になる。返信の形で送るときは「決めてほしいこと」のメッセージへの返信にする。ほかの返事が来たら、待っていた操作は取りやめる。
3. 許可すると、受付はその操作を `STATE_DIR/guard/grants/<投稿の ID>.json` に書き、許可したことを席への答えにする。hook はその投稿の席でだけ、同じ道具・同じ内容（Bash 以外はキーの順によらない引数の JSON）の操作を、auto モードの判定によらず 1 回だけ通す。席から次の質問か報告が届いた時点で、使わなかった許可は失効し、次に同じ操作をするとまた止まる。

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
| `WORK_DIR` | いいえ | 受付が動かす CLI（件名の要約、記憶、`gh`）の作業ディレクトリ。既定は `~/work` |
| `PERSONA_SCRIPT` | いいえ | 人格を出力するスクリプト。既定は `~/bin/persona.sh` |
| `HANDOFF_DIR` | いいえ | `prompt.md` と `issue-template.md` の置き場所。既定は `~/handoff` |
| `GH_TOKEN` | いいえ | 席の Claude の `gh` と `git push` が使う書き込みトークン |
| `GIT_AUTHOR_NAME` など | いいえ | 席の Claude の commit の作者。`GIT_AUTHOR_*` と `GIT_COMMITTER_*` を渡す |
| `YUNOMI_URL` | いいえ | Worker の URL。`yunomi-memory` が Working の記憶の口（`/v1/partners/:partnerId/working/memory`）を呼ぶ |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | いいえ | Working 用の Access service token。Worker の `accessCallers` で `working` に引かれる。席の Claude には渡さない |
| `CHIMERA_URL` | いいえ | chimera の URL。`chimera:` の行の画像を取る |
| `CHIMERA_ACCESS_CLIENT_ID` / `CHIMERA_ACCESS_CLIENT_SECRET` | いいえ | chimera の Access service token。受付だけが使い、席の Claude には渡さない |
| `MEMORY_BIN` | いいえ | 朝会で記憶を読む CLI。既定は `yunomi-memory` |
| `MAC_STATE_TOKEN` | いいえ | Mac と共有するトークン。設定したときだけ席の状態の受け口を開く |
| `MAC_STATE_PORT` | いいえ | 席の状態の受け口のポート。既定は `8090` |
| `STANDUP_ENABLED` | いいえ | `false` で朝会を止める。既定は `true` |
| `STANDUP_TIME` | いいえ | 朝会の時刻（`HH:MM`、Asia/Tokyo）。既定は `09:00` |
| `STANDUP_GITHUB_OWNER` | いいえ | 朝会で PR と申し送りを探す GitHub の owner。既定は `ochanuco` |
| `CLAUDE_BIN` | いいえ | 受付が件名の要約とログインの期限に使う Claude CLI のパス。既定は `claude` |
| `ORCA_BIN` | いいえ | Orca の CLI。既定は `orca-ide` |
| `SEATS_REPO` | いいえ | 席の元にする空の git リポジトリ。既定は `~/work/seats` |
| `SEATS_DIR` | いいえ | Orca が席の worktree を作る場所。既定は `~/work/orca/workspaces/seats`。受付と `seat-env.sh` の両方が読む |
| `SEAT_LIMIT` | いいえ | 同時に Claude を動かしておく席の上限。既定は `6` |
| `SEAT_SLEEP_AFTER_MINUTES` | いいえ | `決めてほしい` のままこれだけたった席の Claude を止める。既定は `120` |
| `LOG_LEVEL` | いいえ | `debug` / `info` / `warn` / `error`。既定は `info` |

bot には仕事フォーラムでの投稿の作成・メッセージ送信・スレッドの管理（タグの付け替え）と、メッセージ履歴を読む権限が要る。

## 配備

main への push で `.github/workflows/working-image.yml` が `ghcr.io/ochanuco/yunomi-working:main` と `:sha-<short>` を公開する。PR ではビルドだけ確かめる。

gateway と同じホストに、gateway とは別の compose project で置く（`compose.example.yaml`）。gateway を更新しても Working の作業は止まらない。

- 受付は docker0 のゲートウェイ（`172.17.0.1:8180`）にだけ公開する。gateway は `extra_hosts: host.docker.internal:host-gateway` を足し、`WORKING_URL=http://host.docker.internal:8180/events` で送る。
- 席の状態の受け口（コンテナの `8090`）は、Mac から届く LAN の口に公開する。`MAC_STATE_URL` は `http://<host>:<公開したポート>/mac-state` にする。
- `restart: unless-stopped` で、ホストの再起動後も受付と `orca serve` が上がる。
- volume は 4 つ（上の表）。コンテナを作り直しても、ログイン・pairing・投稿と席の対応・席の worktree と Claude の会話が残る。席の Claude はコンテナと一緒に終わるので、受付は起動時に止めた席として扱い、返事で起こす。

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

### 3. 席で作業させる

仕事フォーラムに投稿を立てると、受付がその投稿の席を作る。席は Mac の Orca の `working` 環境に、`seat-<投稿の ID>` の worktree として見える。コンテナの中からは次で確かめる。

```sh
docker exec working orca-ide worktree list --json | jq -r '.result.worktrees[].path'
docker exec working orca-ide terminal list --json | jq -r '.result.terminals[] | "\(.handle) \(.title)"'
```

`docker rm -f working` で作り直しても、ログイン・pairing・投稿と席の対応・席の worktree と会話は volume に残る。

`.env.working` には上の環境変数を書く（commit しない）。受付は起動時に Discord に接続できなければ終了し、コンテナも一緒に終わる。
