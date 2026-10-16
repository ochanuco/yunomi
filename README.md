# yunomi

湯呑み（You know me）。Discord で会話する、記憶と関係性を持ち続ける AI パートナーの実行基盤です。
現在のパートナーは結月ゆかり（Yukarin）です。

パートナーは呼ばれたときに応答するだけでなく、チャンネルの流れと相手との関係の段階から「いま話すかどうか」を自分で判断します。
会話から得た事実や約束、興味や意見を記憶し、次の会話に持ち越します。

## 構成

```text
Discord ──▶ apps/gateway ──▶ apps/worker (Cloudflare Worker)
              discord.js         ├─ PartnerDO: パートナーごとの状態・履歴・会話パイプライン
                                 ├─ Claude API: 応答の生成と発話判定
                                 ├─ D1 / R2: 記憶・監査・KPI / 暗号化スナップショット
                                 ├─ 音声合成（任意）: ochoko 経由で A.I.VOICE
                                 └─ /admin/: 読み取り専用の管理画面と API
```

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

音声合成は [ochoko](https://github.com/ochanuco/ochoko)（A.I.VOICE 用の Voice MCP サーバー）を呼び出します。

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
