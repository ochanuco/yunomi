#!/usr/bin/env bash
# 使い方: scripts/deploy.sh <development|production>
# CLOUDFLARE_API_TOKEN は呼び出し側（op run）が環境変数で渡す。
# ANTHROPIC_API_KEY と DISCORD_BOT_TOKEN は、設定されていれば Worker secret として一緒に反映する。
set -euo pipefail

mode=${1:?usage: deploy.sh <development|production>}
case $mode in
  development | production) ;;
  *) echo "mode は development か production を指定する: $mode" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

# resources.ts を唯一の定義元として読む
read -r worker host d1_id placeholder age_recipient age_pattern < <(
  MODE=$mode node --input-type=module -e '
    const { resources, D1_PLACEHOLDER_ID, AGE_RECIPIENT_PATTERN } = await import("./resources.ts");
    const r = resources[process.env.MODE];
    console.log(r.worker, r.host, r.d1Id, D1_PLACEHOLDER_ID, r.snapshotAgeRecipient, AGE_RECIPIENT_PATTERN);
  '
)

if [ "$d1_id" = "$placeholder" ]; then
  echo "error: $mode の D1 database id がプレースホルダのまま。infra Issue (#7) で D1 を作成し、apps/worker/resources.ts を実 UUID に差し替えてから実行する。" >&2
  exit 1
fi

# 暗号化先が age の公開鍵でないと、Snapshot を誰も復号できなくなる
if ! printf '%s' "$age_recipient" | grep -Eq "$age_pattern"; then
  echo "error: $mode の SNAPSHOT_AGE_RECIPIENT が age の公開鍵（age1...）の形式ではない: $age_recipient。apps/worker/resources.ts を実際の公開鍵に差し替えてから実行する。" >&2
  exit 1
fi

# production の D1 migration はデプロイでは適用せず、migration を含む PR ごとに手で適用する
if [ "$mode" = development ]; then
  pnpm exec cf d1 migrations apply "$d1_id" --dir migrations --mode "$mode"
fi

# admin 画面は Worker のソースに埋め込むので、admin をビルドしてから埋め込みを生成する
pnpm --dir ../.. exec turbo build --filter=@yunomi/worker...

deploy_args=(--mode "$mode")
secrets_file=$(mktemp)
trap 'rm -f "$secrets_file"' EXIT
chmod 600 "$secrets_file"
# secret を argv に載せないため、deploy の --secrets-file（.env 形式）で渡す
for name in ANTHROPIC_API_KEY DISCORD_BOT_TOKEN; do
  if [ -n "${!name:-}" ]; then
    printf '%s=%s\n' "$name" "${!name}" >> "$secrets_file"
  fi
done
if [ -s "$secrets_file" ]; then
  deploy_args+=(--secrets-file "$secrets_file")
fi
pnpm exec cf deploy "${deploy_args[@]}"

for attempt in $(seq 1 10); do
  if curl -fsS --max-time 10 "https://$host/health" > /dev/null; then
    echo "$worker: https://$host/health OK"
    exit 0
  fi
  echo "health check 再試行 ($attempt/10)" >&2
  sleep 6
done
echo "error: https://$host/health が応答しない" >&2
exit 1
