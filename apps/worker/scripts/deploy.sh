#!/usr/bin/env bash
# 使い方: scripts/deploy.sh <development|production>
# CLOUDFLARE_API_TOKEN は呼び出し側が環境変数で渡す。
# ANTHROPIC_API_KEY・DISCORD_BOT_TOKEN・AIVOICE_TOKEN・CF_ACCESS_CLIENT_ID・CF_ACCESS_CLIENT_SECRET と、
# 道具（Google カレンダーと Google Places）の GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET・GOOGLE_REFRESH_TOKEN・GOOGLE_CALENDAR_ID・GOOGLE_PLACES_API_KEY・OWNER_DISCORD_USER_ID は、
# 設定されていれば Worker secret として一緒に反映する。
set -euo pipefail

mode=${1:?usage: deploy.sh <development|production>}
case $mode in
  development | production) ;;
  *) echo "mode は development か production を指定する: $mode" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

# resources.ts を唯一の定義元として読む
read -r worker host d1_id placeholder age_recipient age_pattern send_from_worker < <(
  MODE=$mode node --input-type=module -e '
    const { resources, D1_PLACEHOLDER_ID, AGE_RECIPIENT_PATTERN } = await import("./resources.ts");
    const r = resources[process.env.MODE];
    console.log(r.worker, r.host || "-", r.d1Id, D1_PLACEHOLDER_ID, r.snapshotAgeRecipient || "-", AGE_RECIPIENT_PATTERN, r.discordSendFromWorker);
  '
)

# 足りないものを一度にすべて示し、直してから再実行できるようにする
errors=()
warnings=()
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  errors+=("CLOUDFLARE_API_TOKEN が未設定。Workers・D1・R2 を編集できる Cloudflare API token を環境変数で渡す。")
fi
if [ "$host" = - ]; then
  errors+=("apps/worker/resources.ts の $mode.host が空。Worker を置くホスト名（自分のゾーンのもの）を書く。")
fi
if [ "$d1_id" = "$placeholder" ]; then
  errors+=("apps/worker/resources.ts の $mode.d1Id がプレースホルダのまま。D1 を作り（pnpm exec wrangler d1 create <name>）、その UUID を書く。")
fi
# 暗号化先が age の公開鍵でないと、Snapshot を誰も復号できなくなる
if ! printf '%s' "$age_recipient" | grep -Eq "$age_pattern"; then
  errors+=("apps/worker/resources.ts の $mode.snapshotAgeRecipient が age の公開鍵（age1...）ではない: ${age_recipient}。age-keygen で鍵を作り、公開鍵を書く。")
fi
# secret は前回のデプロイで反映済みのことがあるので、未設定でも止めない
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  warnings+=("ANTHROPIC_API_KEY が未設定。Worker secret に無ければ、デプロイ後に応答を生成できない。")
fi
if [ "$send_from_worker" = 1 ] && [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  warnings+=("DISCORD_BOT_TOKEN が未設定。$mode.discordSendFromWorker が 1 なので、Worker secret に無ければ返事を送れない。")
fi

for w in "${warnings[@]+"${warnings[@]}"}"; do
  echo "warning: $w" >&2
done
if [ ${#errors[@]} -gt 0 ]; then
  for e in "${errors[@]}"; do
    echo "error: $e" >&2
  done
  echo "手順は docs/self-hosting.md を参照。" >&2
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
for name in ANTHROPIC_API_KEY DISCORD_BOT_TOKEN AIVOICE_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN GOOGLE_CALENDAR_ID GOOGLE_PLACES_API_KEY OWNER_DISCORD_USER_ID; do
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
