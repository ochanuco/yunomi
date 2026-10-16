# yunomi

湯呑み（You know me）。記憶と関係性を持ち続ける AI パートナーの実行基盤です。
現在のパートナーは結月ゆかり（Yukarin）です。

## 考え方

### コアと器官

判断と状態は Cloudflare 上のコア（Worker と Partner DO）だけが持ちます。
人格、記憶、関係や感情の状態、身体の状態、何を言い何をするかの判断はすべてコアにあります。

それ以外は付け替えのきく器官としてつなぎます。
器官は実行と知覚だけを担い、キャラクターの知識を持たず、判断もしません。

| 身体機能 | 今の器官 |
|---|---|
| 考える助け | Claude API |
| 話す | [ochoko](https://github.com/ochanuco/ochoko)（A.I.VOICE） |
| やりとり | Discord（常時接続は Gateway が持つ） |

器官がどこで動き、どう届くかはアダプタの中に閉じます。
器官が使えないときもコアは動き続け、パートナーはそれを身体の状態として受け取ります。

### 心・脳・身体

![コアの心・脳・身体と、各身体機能の口につながる器官](docs/images/core-layers.svg)

コアは3つの層に分かれます。

| 層 | 持つもの |
|---|---|
| 心 | 人格、価値観、感情、関係、意見と興味、記憶の中身 |
| 脳 | 知覚を受け取る、思い出す、考える（LLM は脳の器官）、何をするか決める |
| 身体 | 身体機能の口、表現からエンジンの値への変換、器官の段取り、身体の状態 |

依存の向きは「脳 → 心」と「脳 → 身体」だけです。
心は脳から提案された変化を、自分の規則で受け入れるかどうか決めます。
そのため器官を付け替えても心は変わらず、パートナーが別人になることはありません。

### キャラクターごとのコア

![キャラクターごとの Partner DO と、物理的に共有する器官](docs/images/characters.svg)

コアはキャラクターごとに1つあり、キャラクター同士で状態を共有しません。
器官は物理的に共有してよいものの、プロンプトや文脈、声のプリセット、身体の状態はキャラクターごとに分けます。

詳しくは [docs/design/principles.md](docs/design/principles.md) を参照してください。

## 構成

| パス | 役割 |
|---|---|
| `apps/worker` | Cloudflare Worker。パートナーごとの Durable Object、記憶、夜間バッチ、Admin API |
| `apps/gateway` | Discord Gateway に常時接続し、メッセージを Envelope にして Worker へ送る |
| `apps/admin` | Admin Web（Vite + plain DOM）。Worker に埋め込んで `/admin/` で配信する |
| `apps/cli` | `ykm`。Admin API を読む CLI（状態、記憶、KPI、監査ログ、スナップショット） |
| `packages/core` | ID、`Result` とドメインエラー、Envelope、EventBus、ドメイン型 |
| `packages/protocol` | Gateway と Worker の間の Discord 向けプロトコル |
| `packages/conversation` | プロンプト組み立て、発話判定プロンプト、応答スキーマ |
| `packages/llm` | LLM プロバイダの抽象と Claude 実装 |
| `packages/admin-contract` | Admin API の応答型と Valibot スキーマ |
| `partners/yukarin` | ゆかりの人格本文とプロファイル |
| `evals` | persona eval。Tier 1 は決定的なテスト、Tier 2 は実際の Claude API を使う統計的な評価 |

## 開発

Node 24 と pnpm 10 が必要です（`mise.toml` で固定しています）。

```sh
pnpm install
pnpm turbo typecheck lint test   # PR 前に通す
pnpm turbo build
pnpm turbo eval                  # persona eval
pnpm format                      # Biome で整形
```

パッケージ単位で動かすときは `pnpm --filter <name> <script>` を使います。

```sh
pnpm --filter @yunomi/worker dev    # Worker をローカルで起動
pnpm --filter @yunomi/gateway start # Gateway を起動
pnpm --filter @yunomi/cli ykm status
```

自分の環境にデプロイする手順は [docs/self-hosting.md](docs/self-hosting.md) にあります。
設定と運用の詳細は各ディレクトリの README にあります。

- [apps/worker/README.md](apps/worker/README.md): Worker の設定、secret、デプロイ
- [apps/gateway/README.md](apps/gateway/README.md): Gateway の設定と実行
- [apps/cli/README.md](apps/cli/README.md): `ykm` の使い方
- [apps/admin/README.md](apps/admin/README.md): Admin Web
- [evals/README.md](evals/README.md): eval の書き方と実行
- [partners/yukarin/README.md](partners/yukarin/README.md): ゆかりのプロファイル

## 設計

- [docs/design/](docs/design/README.md): 設計原則、アーキテクチャ、記憶、人格、音声、セキュリティなど
- [docs/plan/](docs/plan/mvp-plan.md): MVP と音声対応の実装計画

## License

[MIT](LICENSE)
