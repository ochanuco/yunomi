# 自分の環境にデプロイする

フォークしたリポジトリを、自分の Cloudflare アカウント、Discord bot、Anthropic API key で動かす手順です。
このリポジトリの値（ホスト名、D1 id、Access の設定、公開鍵など）は作者の環境のものなので、すべて自分の値に差し替えます。

## 必要なもの

| もの | 用途 |
|---|---|
| Node 24、pnpm 10 | ビルドと実行（`mise.toml` で固定） |
| Cloudflare アカウントと、そのアカウントにあるゾーン | Worker、D1、R2、Access。`workers.dev` は無効にしてあるので、独自ドメインが要る |
| Cloudflare Zero Trust（Access） | Worker の認証。`/health` 以外のすべての経路で Access の JWT を検証する |
| Discord の bot | パートナーの体。Gateway と Worker が同じ bot を使う |
| Anthropic API key | 応答の生成 |
| [age](https://github.com/FiloSottile/age) の鍵ペア | Partner Snapshot の暗号化 |
| Gateway を常時動かせるホスト | Discord Gateway への常時接続（Docker か Node 24） |

音声（ochoko と wol）はなくても動きます。手順では音声を無効にして進めます。

## 1. Cloudflare のリソースを作る

`cf` CLI は `apps/worker` の devDependencies に入っています。コマンドは `apps/worker` で実行します。
認証には環境変数 `CLOUDFLARE_API_TOKEN` を使います。Workers、D1、R2 を編集できる API token を作って設定してください。

```sh
pnpm install
cd apps/worker
export CLOUDFLARE_API_TOKEN=...
```

- D1 database を作り、UUID を控える
- R2 bucket を作る（`cf` は bucket を作らないので、ダッシュボードか Wrangler で作る）

```sh
pnpm exec wrangler d1 create yunomi
pnpm exec wrangler r2 bucket create yunomi-snapshots
```

## 2. Snapshot の鍵を作る

Worker は夜間に Partner Snapshot を作り、age の公開鍵で暗号化して R2 に置きます。
Worker は秘密鍵を持ちません。秘密鍵は自分の手元で保管してください。

```sh
age-keygen -o yunomi-snapshot.key   # 出力される age1... が公開鍵
```

`scripts/deploy.sh` は公開鍵が `age1...` の形でないとデプロイを止めます。

## 3. Cloudflare Access を設定する

Worker は、`/health` 以外へのリクエストに `Cf-Access-Jwt-Assertion` を求めます（`src/auth/access.ts`）。

1. Zero Trust のチームドメインを確認する（`<team>.cloudflareaccess.com`）
2. Worker のホスト名に self-hosted の Access application を作り、AUD タグを控える
3. policy を設定する
   - 自分のメールアドレスを許可する（Admin Web 用）
   - Service Auth で、次の 2 つの service token を許可する
   - `/health` を bypass する（`deploy.sh` が認証なしで確認する）
4. service token を 2 つ作る
   - Gateway 用
   - `ykm`（CLI）用

JWT にメールアドレスがあれば `OWNER_EMAILS` と照合し、owner として扱います。
service token の JWT は `common_name`（service token の Client ID）を `ACCESS_CALLERS` で `gateway` か `ykm` に引きます。

## 4. Discord bot を作る

Discord Developer Portal でアプリケーションと bot を作ります。

- Privileged Gateway Intents の Message Content を有効にする（Gateway は `Guilds`、`GuildMessages`、`MessageContent` を使う）
- サーバーに招待するときの権限: メッセージの送信、メッセージ履歴の閲覧、ファイルの添付
- Application ID（bot の user id）と bot token を控える

## 5. 設定を書き換える

### `apps/worker/resources.ts`

`development` と `production` のうち、使う mode の値を書き換えます。片方だけ使ってもかまいません。

| キー | 値 |
|---|---|
| `worker` | Worker 名 |
| `host` | Worker を置くホスト名（自分のゾーンのもの） |
| `d1Id` | 1 で作った D1 の UUID |
| `partnerDiscordUserId` | bot の Application ID |
| `discordSendFromWorker` | `"1"` なら Worker が返事を送る（`DISCORD_BOT_TOKEN` が要る）。`"0"` なら Gateway が送る |
| `voiceEnabled` | 音声を使わないなら `"0"` |
| `snapshotBucket` | 1 で作った R2 bucket 名 |
| `snapshotAgeRecipient` | 2 で作った公開鍵 |

### `apps/worker/cloudflare.config.ts`

| 値 | 書き換え先 |
|---|---|
| `ACCESS_TEAM_DOMAIN` | 3 のチームドメイン |
| `ACCESS_AUD_PROD` / `ACCESS_AUD_DEV` | 3 の AUD タグ |
| `ACCESS_CALLERS_PROD` / `ACCESS_CALLERS_DEV` | `{ "<Gateway 用 Client ID>": "gateway", "<ykm 用 Client ID>": "ykm" }` |
| `OWNER_EMAILS` | 自分のメールアドレス |
| `OCHOKO_URL` / `WOL_URL` | 音声を使うときだけ |

夜間バッチの cron は `17 19 * * *`（UTC、日本時間 4:17）です。

## 6. Worker をデプロイする

secret は環境変数で `scripts/deploy.sh` に渡します。設定されているものだけが Worker secret として反映されます。

| secret | 要否 |
|---|---|
| `ANTHROPIC_API_KEY` | 必須。ないと応答を生成できない |
| `DISCORD_BOT_TOKEN` | `discordSendFromWorker` が `"1"` のとき必須 |
| `AIVOICE_TOKEN`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET` | 音声を使うときだけ |

```sh
cd apps/worker
export CLOUDFLARE_API_TOKEN=... ANTHROPIC_API_KEY=... DISCORD_BOT_TOKEN=...
scripts/deploy.sh production
```

`deploy.sh` は次の順に実行します。

1. `resources.ts` の D1 id と公開鍵を確かめる
2. `development` のときだけ D1 migration を適用する
3. Admin Web をビルドして Worker に埋め込み、`cf deploy` する
4. `https://<host>/health` が応答するまで確かめる

`production` の D1 migration は自動では適用しません。初回と、migration が増えたときに手で適用します。

```sh
pnpm exec cf d1 migrations apply <D1 の UUID> --dir migrations --mode production
```

## 7. Gateway を動かす

Gateway は Discord のメッセージを Worker に中継します。環境変数で設定します。

| 変数 | 値 |
|---|---|
| `DISCORD_TOKEN` | bot token |
| `YUNOMI_URL` | `https://<host>` |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | Gateway 用 service token（2 つともそろえる） |
| `LOG_LEVEL` | 任意 |

ソースから動かす場合:

```sh
pnpm --filter @yunomi/gateway start
```

Docker で動かす場合は、イメージを自分でビルドします。`apps/gateway/compose.example.yaml` を元に compose を書き、`.env` で変数を渡します。

```sh
docker build -f apps/gateway/Dockerfile -t yunomi-gateway .   # リポジトリルートで実行
```

bot をメンションして、返事が来れば動いています。

## 8. `ykm` と Admin Web

- Admin Web は `https://<host>/admin/` で開けます。Access で自分のメールアドレスでログインします
- `ykm` は既定の URL が作者の環境なので、`YKM_PROD_URL`（dev は `YKM_DEV_URL`）で自分のホストを指定します
- 認証は `YKM_ACCESS_CLIENT_ID` / `YKM_ACCESS_CLIENT_SECRET` に `ykm` 用 service token を渡します

```sh
YKM_PROD_URL=https://<host> pnpm --filter @yunomi/cli ykm status --env prod
```

## ローカルで動かす

Access も Discord もなしで、Worker だけをローカルで動かせます。

```sh
pnpm --filter @yunomi/worker db:migrate:local
pnpm --filter @yunomi/worker dev
```

`local` mode では Access の代わりに `x-yunomi-dev-caller` ヘッダーで呼び出し元を名乗れます。Gateway は `YUNOMI_DEV_CALLER=1` と `YUNOMI_URL=http://localhost:<port>` でつなぎます。

## 作者の環境に依存しているもの

次のものは作者の環境に合わせてあるので、フォークでは削除するか、自分の環境に合わせて書き換えます。

- `.github/workflows/deploy*.yml`、`eval-nightly.yml`: 作者の 1Password と共有 workflow を使う
- `.github/deploy/*.env.op`、`apps/gateway/*.env.op`: 作者の 1Password の参照
- `.github/workflows/gateway-image.yml`: 作者の GHCR にイメージを公開する

## キャラクターを変える

パートナーは `partners/yukarin` に固定されています（Worker の `src/index.ts` と Gateway の `src/main.ts`）。
別のキャラクターにするには、`partners/yukarin` の人格本文とプロファイルを書き換えて `pnpm --filter @yunomi/partner-yukarin gen` を実行するのが最も手軽です。
ゆかりの人格を使う場合は、`partners/yukarin/README.md` の注意書きを確認してください。
