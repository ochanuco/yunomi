# @yunomi/worker

## 構成

- 設定は `cloudflare.config.ts` のみ。`cf` CLI が読む。`--mode production` で本番（Worker `yunomi`、`yunomi.chanu.co`）、省略または `development` で開発（`yunomi-dev`、`yunomi-dev.chanu.co`）、`--mode local` でローカル専用（`yunomi-local`、ドメインなし）に切り替わる。local は deploy しない。workers.dev と preview URL は無効。
- `cf dev` / `cf build` の委譲先は `wrangler`（この package の devDependency）。Vite は使わない。
- `ANTHROPIC_API_KEY` は `bindings.secret()` で宣言のみ。ローカルは `.dev.vars` に書く（未設定でも `/health` は動く）。
- `/health` は認証を要求しない（Cloudflare Access 側で bypass）。それ以外は `src/auth/access.ts` が `Cf-Access-Jwt-Assertion`（RS256）を `ACCESS_TEAM_DOMAIN` の JWKS・`ACCESS_AUD`・issuer で検証する。`email` が `OWNER_EMAILS` にあれば owner、service token は `common_name` を `ACCESS_CALLERS` で `gateway` / `ykm` に引く。`POST /v1/interfaces/discord/events` と `POST /v1/partners/:partnerId/discord/sent` は `gateway` のみ。
- ローカル開発の迂回: `ALLOW_DEV_CALLER=1` のとき、ヘッダ `x-yunomi-dev-caller: gateway|ykm` でその呼び出し元として扱う。`ALLOW_DEV_CALLER` は `--mode local` だけが `"1"` にし、development / production は `"0"`。`pnpm --filter @yunomi/worker dev` は `cf dev --mode local`。`cf dev` はカスタムドメインがあると request.url を書き換えるため、host では判定しない。
- Worker 名・ホスト・D1 database id は `resources.ts` に集約し、`cloudflare.config.ts` と `scripts/deploy.sh` が読む。`cf` の D1 database id は全ゼロ UUID を拒否するため、infra Issue (#7) で実 UUID に差し替えるまで `00000000-0000-4000-8000-000000000000` を置いている。

## 型

`pnpm typecheck` は `cf workers types`（`.cloudflare/types/index.d.ts` を生成、ネットワーク不要）の後に `tsc`。`cloudflare.config.ts` の `Env` とworkerd のランタイム型が入るため `@cloudflare/workers-types` は不要。`cloudflare.config.ts` は worker を名前で参照する DO binding の型を推論できないので、`src/index.ts` で `DurableObjectNamespace<PartnerDO>` に絞っている。

## テスト

`vitest.config.ts` が `cloudflare.config.ts` を `@cloudflare/config` の `loadAndParseConfig` + `convertToWranglerConfig` で読み、`.wrangler/test/wrangler.json` を生成して `@cloudflare/vitest-plugin` に渡す（Wrangler 設定の手書きは無い）。plugin が必要とする DO の `migrations` を足し、secret / routes は落としている。D1 migration は `test/apply-migrations.ts` で適用する。`@cloudflare/config` は公式に unstable なので、破れたら miniflare binding のインライン指定に切り替える。

## D1 migration

`pnpm db:generate`（drizzle-kit、`migrations/NNNN_name.sql` のフラット配置は `cf d1 migrations apply` の既定 pattern `*.sql` と一致）。`pnpm db:migrate:local` は `cf dev` が使う `.wrangler/state` へ migration を適用する（`cf d1 migrations apply --local` は別の state を見るため使わない）。初回の `pnpm dev` の前に一度実行する。

## Partner DO

`PartnerDO`（`idFromName(partner_id)`）が会話状態を持つ。DO SQLite のテーブルは `src/do/schema.ts` の versioned migration でコンストラクタ内に作る。`handleDiscordMessage` は dedupe（`processed_events`、7 日）、チャンネル単位の直列化（処理中に届いた発言は `recent_messages` に積み、完了後に最新 1 件だけ再判定、古い待機は `coalesced` で ignore）、`pipeline` の呼び出しを行う。`pipeline` と `now` はテストが `runInDurableObject` で差し替える seam。

reply の応答には、DO が `recent_messages` に積んだ Yukarin 発言の id（`partner_message_id`、`partner:<uuid>`）を含める。Gateway が送信後に `POST /v1/partners/:partnerId/discord/sent`（body: `partner_message_id` / `channel_id` / `discord_message_id`、応答 `{ bound }`）を呼ぶと、DO はその行の `discord_message_id` に Discord id を保存する。以後 `reply_to_message_id` がその Discord id と一致する発言は、メンションなしでも Yukarin への返信として LLM 判定に進む。通知前の行や既存行は `discord_message_id` が NULL のままで、従来どおり動く。

## State / Relationship

純粋なドメイン関数は `@yunomi/core` の `partner-state.ts`（`applyStateDelta` / `applyRelationshipDelta`、日次上限は `lifestyleDay` の JST 05:00 境界）。現在値は DO SQLite（`partner_state`、`relationships`）、履歴は D1（`state_transitions`、`relationship_events`）。D1 の履歴書き込みは `ctx.waitUntil` に載せて応答を待たせない。テストは `PartnerDO.flushBackground()` で完了を待つ。作者の entity 解決（`entities` / `external_identities`）は LLM 判定に進んだときに行う。

LLM 障害は `degradedMode` / `systemStress` に自動で反映する（`applyLlmFailure` / `applyLlmSuccess`、閾値は `partner-state.ts` の定数）。LLM を呼んで失敗したターンだけが対象で、前段ルールで決まったターンや entity 解決の失敗は数えない。成功を挟まない連続失敗が 3 回で `degradedMode=true` かつ `systemStress` +0.2、以降 `degradedMode` 中の失敗は 1 回ごとに +0.1（上限 1.0）。LLM が 1 回成功すると `degradedMode=false`、連続失敗カウンタ（DO SQLite の `llm_health`）を 0 に戻し、`systemStress` を −0.1（下限 0）する。`degradedMode` 中の応答の振る舞いは変えない。遷移は `state_transitions.reason`（`llm_consecutive_failures` / `llm_recovered`。通常のターンは `turn_delta`）付きで残り、`degradedMode` が切り替わったターンの audit `detail_json.degradedTransition` に `entered` / `recovered` が入る。

## Memory

LLM の `memory_candidates` は D1 の `memory_candidates` に保存し、`decidePromotion`（`@yunomi/core`）の決定的な規則で `facts` に昇格する。話者を指す subject（`user` / `speaker` / 表示名 / Discord user id）以外は entity を解決できないため `pending` のまま `subject_text` に原文を残す。prompt には話者の現行 Fact を importance 降順・observed_at 降順で上位 12 件入れる。書き込みは次のターンが読めるよう応答前に完了させる。

## Open Loop

会話中の未解決の話題・あとで聞き返したい続き（結果待ち、相手自身の予定、困りごとの続き）。タスクやリマインダーではなく、今回は抽出・保存・解決の記録までで、フォローアップ発話や期限の評価はしない（`follow_up_interval_hours` と `last_followed_up_at` は常に null）。

LLM の応答は `open_loops`（`summary` / `importance` / `due_at` / `due_confidence`、不在は空配列か null）と `resolved_open_loop_ids` を返す。D1 の `open_loops` に保存し、`reply` で終わったターンだけが対象になる。前段ルールで決まったターン、LLM の `ignore`、LLM 障害（degraded）では追加も解決もしない。書き込みは次のターンの prompt に載るよう memory と同じく応答前に完了させ、失敗しても返信は止めず audit の `error` に残す。

- 検証と重複排除は `@yunomi/core` の `open-loop.ts`。数値は clamp せず範囲外の候補を捨てる。`summary` は NFKC・小文字化・空白圧縮した値が、同じ partner・entity の open な行と同じなら追加しない。1 ターンの追加は `OPEN_LOOP_MAX_PER_TURN`（2）件、entity あたりの open は `OPEN_LOOP_MAX_OPEN_PER_ENTITY`（20）件まで。
- prompt には話し相手の open な行を importance 降順（同点は新しい順）で `OPEN_LOOP_PROMPT_LIMIT`（5）件、id 付きで入れる。LLM が返した `resolved_open_loop_ids` のうち、その entity の open な行だけを `resolved`（`resolved_at` 付き）にする。他人の行、open でない行、存在しない id は無視する。
- 解決を先に適用するので、同じターンで片づいた分の枠は追加の上限判定に使える。同時に走る別チャンネルのターンが同じ summary を同時に追加した場合の二重登録は防がない。

## Interest / Opinion

Yukarin の興味（Interest）と意見（Opinion）。初期値は `partners/yukarin/profile.yaml` の `interests` / `opinions` で、D1 の `interest_states` / `opinion_states`（PK は partner_id + topic）に行が無い topic はその初期値として扱う。読み出し時に初期値で補い、初回の変化で行を作る。変化の履歴は `interest_changes` / `opinion_changes`（before / after、reason、`source_message_id`、生活日）に残す。

LLM の応答は `interest_signals`（最大 2 件。`topic` / `direction` が `up` か `down` / `reason`）と `opinion_signals`（最大 1 件。`topic` / `direction` が `strengthen` / `weaken` / `shift` / `new_stance`（`shift` のときだけ、他は null）/ `reason`）を返す。LLM が返すのは向きだけで、大きさは `@yunomi/core` の `interest-opinion.ts` の定数で決める。`topic` はプロファイルにあるキーだけ有効で、未知の topic は捨てる。`reply` で終わったターンだけが対象で、前段ルールで決まったターン、LLM の `ignore`、LLM 障害（degraded）では何もしない。書き込みは次のターンの prompt に載るよう応答前に完了させ、失敗しても返信は止めず audit の `interestOpinion.error` に残す。

- Interest: 1 シグナルで score が `INTEREST_SIGNAL_STEP`（0.03）動く。同じ topic の生活日あたりの純変化は `INTEREST_DAILY_CAP`（±0.1）、baseline からの乖離（`learned_delta`）は `INTEREST_LEARNED_DELTA_CAP`（±0.3）まで。score は 0〜1。上限の残りが 1 ステップに満たないときは残り分だけ動く。
- Opinion: `strengthen` / `weaken` は confidence を `OPINION_CONFIDENCE_STEP`（0.05）×（1 − stability）だけ動かす。`shift` は confidence を同じだけ下げ、その結果が `OPINION_SHIFT_THRESHOLD`（0.25）を下回り、かつ `new_stance` があるときだけ stance を置き換えて confidence を `OPINION_SHIFT_RESET_CONFIDENCE`（0.4）にする。同じ topic は生活日に `OPINION_MAX_CHANGES_PER_DAY`（1）回まで。`reasons` は新しい `reason` を足して `OPINION_REASONS_MAX`（5）件に保ち、stance を置き換えたときは置き換えの reason だけにする。`source_memory_ids` は今は常に空。
- 適用しなかったシグナルは audit の `interestOpinion.{interests,opinions}.rejected` に `unknown_topic` / `limit` / `daily_cap` / `learned_cap` / `no_change` で残す。適用したものは `applied` に before / after が入る。日次の集計は履歴テーブルから読むため、同時に走る別チャンネルのターンが同じ topic を同時に更新すると、上限をわずかに超えることがある。
- prompt には現在の Interest（score の降順、全件）と Opinion（全件。confidence を「強く思う（0.7 以上）/ そう思う（0.4 以上）/ 迷っている」で示す）を、topic のキー付きで state・relationship の後ろに入れる。persona と静的ルールだけが cache 対象で、この 2 ブロックは cache の外に置く。

## Audit

1 メッセージにつき `audit_events`（D1）へ 1 行を書く。自己発言は書かない。書き込みは `#background`（`ctx.waitUntil`）に載せ、`flushBackground()` が待つ。思考過程は持たず、判断サマリ・モデル・fallback・token・latency・受信本文と、state / relationship / memory / openLoops / tool_intents の詳細（`detail_json`）だけを残す。`created_at` が `AUDIT_RETENTION_DAYS`（30）より古い行は、毎日 04:17 JST（`17 19 * * *` UTC）の `scheduled` が削除する。

### 日次 KPI

`scheduled` は削除の前に `audit_events` を生活日（JST 05:00 境界）単位で集計し、`audit_daily_kpis`（主キー `(partner_id, day)`）へ upsert する。集計に失敗したら削除しない。列は turns / replies / ignores / errors（`error_type` あり）/ degraded / fallback_used / reply ターンの latency p50・p95（nearest-rank、reply が無い日は null）/ input・output・cache_read・cache_write tokens の合計。進行中の生活日は含めず、直近 `KPI_RECOMPUTE_DAYS`（7）日分の確定済みの日を毎回再集計する。upsert なので何度走らせても同じ結果になり、cron の失敗で取りこぼした日も 7 日以内なら拾える。cron は 04:17 JST（生活日の境界の前）に走るため、ある生活日が集計されるのは翌日の cron になる。保持期間（30 日）内の過去分の遡及集計はしない。

## Admin API

`/admin/api/partners/:partnerId/{status,relationships,memory,open-loops,interests,opinions,audit,kpis}` は読み取り専用（Snapshot は次節）。owner と `ykm` だけが使える（`gateway` は 403、JWT なしや不正は 401）。`memory` は `kind=facts|candidates`。Fact は既定で置き換え済み（`superseded_by` あり）と期限切れ（`valid_to` が現在以前）を除き、`include=all` で全件を返す。`open-loops?status=open|all`（既定 `open`）は Open Loop を新しい順に返し、`all` は resolved / dropped も含める。`interests`（score の降順）と `opinions`（プロファイルの定義順）は現在値で、行の無い topic は初期値を返し、各行に `source: "profile" | "learned"` が付く。`audit` は新しい順で `since` を取れる。`kpis?days=N`（既定 30、1 から 365）は現在の生活日から遡った N 日の確定済み KPI を新しい日から返す。一覧は `limit`（既定 50、最大 200）と、`created_at` と `id` から作る base64url の不透明な `cursor` でたどる。応答の型とスキーマは `@yunomi/admin-contract`。state と relationship の現在値は DO、それ以外は D1 から返す。

## Partner Snapshot

Yukarin の長期記憶と現在値の時点コピー。日次バックアップと、prod から dev への seed に使う。実データなので、リポジトリには Snapshot・テスト鍵以外の鍵・seed を置かない（`*.age` と `/snapshots/` は `.gitignore`）。

#### 中身

JSON（`schema_version` 1、`@yunomi/admin-contract` の `SnapshotSchema`）。`snapshot_id`（UUID v7）/ `partner_id` / `env` / `created_at` に加えて次を持つ。行は `partner_id` を持たない。

- `d1`: `entities` / `external_identities` / `facts` / `memory_candidates` / `open_loops` / `interest_states` / `opinion_states`。`entities` と `external_identities` は partner を持たないので全行
- `do`: `state`（`partner_state`）と `relationships`（日次累積の `acc_*` を含む全列）

含めない: `audit_events`・`audit_daily_kpis`・履歴（`state_transitions` / `relationship_events` / `interest_changes` / `opinion_changes`）、DO の `recent_messages`（会話本文）・`processed_events`・`channel_state`・`entity_cache`・`llm_health`、secret。会話要約は未実装で項目が無い。D1 の対象列は `src/snapshot.ts` の `D1_SNAPSHOT_TABLES` で、テストが実スキーマとの一致を確かめる。

#### 保存

JSON → gzip（`CompressionStream`）→ age（`age-encryption`、公開鍵方式）。Worker は recipient だけを持ち、復号できない。R2 の binding は `SNAPSHOTS`、キーは `snapshots/<partner_id>/<snapshot_id>.json.gz.age`、`customMetadata` に `schema_version` / `created_at` / `env`。bucket は `resources.ts` の mode ごとの値（development は `yunomi-dev-snapshots`、production は `yunomi-snapshots`、local は `yunomi-local-snapshots`）で、事前に作る。

recipient は `SNAPSHOT_AGE_RECIPIENT`（`resources.ts` の `snapshotAgeRecipient`、公開鍵なので commit する）。秘密鍵は 1Password（`op://Personal/yunomi-dev-snapshot-age/credential`、`op://Personal/yunomi-prod-snapshot-age/credential`）にあり、リポジトリにも Worker にも置かない。local mode はテスト用の鍵ペアで、identity は `test/snapshot-keys.ts`。

`scripts/deploy.sh` は recipient が `AGE_RECIPIENT_PATTERN`（`age1` + bech32 の 58 文字）に合わなければ失敗する。プレースホルダや秘密鍵の取り違えがここで止まる。パターンと各 mode の値の整合は `test/snapshot.test.ts` が確かめる。

#### 作成と削除

毎日 04:17 JST の `scheduled` が、KPI 集計・audit 削除より前に Snapshot を作り、`SNAPSHOT_RETENTION_DAYS`（30）より古いものを `customMetadata.created_at` で削除する。作成・削除の失敗は `console.error` に残すだけで、KPI 集計と audit 削除は続ける。手動作成は `POST /admin/api/partners/:partnerId/snapshots`。

#### API

owner と `ykm` だけが使える（`gateway` は 403、JWT なしや不正は 401）。

- `GET .../snapshots`: `{ items: [{ id, created_at, size, schema_version, env }] }`（新しい順）
- `POST .../snapshots`: 作成して 201 と同じ形の 1 件を返す
- `GET .../snapshots/:snapshotId`: 暗号化済みの blob（`application/octet-stream`）をそのまま返す。無ければ 404
- `POST .../snapshots/restore`: body は復号済みの Snapshot JSON。`YUNOMI_ENV=production` では 403 `restore_disabled_in_production`。検証に失敗すれば 400、`partner_id` の不一致や DB の失敗は 422。成功すると `{ snapshot_id, source_env, counts }`

restore は対象 partner の `facts` / `memory_candidates` / `open_loops` / `interest_states` / `opinion_states` を削除して Snapshot の行で入れ直し（`D1Database.batch`、失敗すれば全体を戻す）、DO の `partner_state` / `relationships` を transaction で置き換える（`entity_cache` は捨てる）。`entities` と `external_identities` は履歴テーブルから参照されるため、消さずに upsert する。D1 と DO をまたぐ atomic はなく、D1 を先に書く。途中で止まったら同じ Snapshot でもう一度 restore する。audit・KPI・履歴と `recent_messages` は触らない。restore は Discord や外部サービスを呼ばない（テストで `fetch` の未呼び出しを確認）。1 回ごとに `{"event":"snapshot_restore", snapshot_id, source_env, counts}` を `console.log` に 1 行残す。

#### seed の運用

dev が外部へ作用しないことは、既存の dev / prod 分離（別 bot・別 Worker・別 Access）で担保する。手順は `apps/cli/README.md`。

## Admin Web の配信

`/admin/` 配下は `apps/admin` のビルド成果物を返す。`cloudflare.config.ts` の `assets` が配信ディレクトリを指定できないため、`scripts/embed-admin.ts` が `../admin/dist` を `src/generated/admin-assets.ts`（git 管理外）に埋め込み、`src/admin/static.ts` が返す。`typecheck` / `test` は未ビルドなら空で生成し、`build` は `dist` が無いと失敗する。詳細は `apps/admin/README.md`。

## デプロイ（dev）

`.github/workflows/deploy-dev.yml` が main への push と手動実行で dev に反映する。`pnpm turbo typecheck test` の後、`op run --env-file=.github/deploy/dev.env.op -- scripts/deploy.sh development` を実行する。

`scripts/deploy.sh <development|production>` の流れ:

1. `resources.ts` から D1 id と `snapshotAgeRecipient` を読む。D1 id がプレースホルダのままなら #7 を案内して失敗し、recipient が age の公開鍵の形式でなければ失敗する。
2. `cf d1 migrations apply <id> --dir migrations`（remote）
3. `cf deploy --mode <mode>`。`ANTHROPIC_API_KEY` が環境にあれば `--secrets-file`（権限 600 の一時 `.env`、終了時に削除）で渡す。`cf workers secrets update` は `--text` しか持たず値が argv に載るため使わない。
4. `https://<host>/health` を最大 10 回（6 秒間隔）確認する。

#### 事前に人手で用意するもの

- GitHub Environment `dev` と、その secret `OP_SA_DEPLOY`（vault `yunomi-dev` を読む 1Password Service Account の token）
- 1Password vault `yunomi-dev` の item `yunomi-deploy-dev`（`credential`、Cloudflare API token）と `anthropic-api-key`（`credential`）。参照は `.github/deploy/dev.env.op`
- dev の D1 を作り、`resources.ts` の `development.d1Id` を実 UUID にする
- R2 bucket `yunomi-dev-snapshots` を作る

#7 が終わるまで、このパイプラインは D1 id のガードで失敗する（`OP_SA_DEPLOY` 未設定でも 1Password 認証で失敗する）。

## デプロイ（prod）

`.github/workflows/deploy-prod.yml` は `workflow_dispatch` のみ（main への merge では動かない）。入力 `ref`（既定 `main`）は main か既存の tag に限り、それ以外は最初の step で失敗する。dev と同じ手順で `scripts/deploy.sh production` を実行する。

#### 事前に人手で用意するもの

- GitHub Environment `production`: Required reviewers を設定する（承認は GitHub の設定側で強制され、workflow には書けない）。secret `OP_SA_DEPLOY` は vault `gh-deploy` だけを読む 1Password Service Account `github-deploy` の token（ochanuco の repo の本番デプロイで共用。Environment は chabatake が作る）
- 1Password vault `gh-deploy` の item `cloudflare-workers`（Cloudflare API token、全 repo で共用）と `yunomi-anthropic-api-key`。参照は `.github/deploy/production.env.op`
- prod の D1 を作り、`resources.ts` の `production.d1Id` を実 UUID にする
- R2 bucket `yunomi-snapshots` を作る

#### dev / prod 分離チェックリスト

- D1: `yunomi-dev` と `yunomi` で別 database（別 UUID）
- Worker / DO namespace: `yunomi-dev` と `yunomi`（DO は Worker 単位で分かれる）
- ホスト: `yunomi-dev.chanu.co` と `yunomi.chanu.co`
- Discord bot: 別アプリ・別 token（Gateway の `.env.dev` / `.env.prod`）
- Anthropic API key: 別 key（既定モデルは prod が Sonnet）
- Cloudflare Access: app・AUD・service token を別にする（`cloudflare.config.ts` の `ACCESS_AUD_*` / `ACCESS_CALLERS_*`）。dev の token で prod に入れない
- 1Password: vault `yunomi-dev` / `gh-deploy`（prod は ochanuco の repo 共用）、Service Account も別
- GitHub Environment: `dev`（承認なし）/ `production`（承認必須）
