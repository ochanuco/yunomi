#!/usr/bin/env bash
# Working 受付と、引数で渡したコマンド（orca-ide serve など）を並べて動かす。
# どちらかが終わったらコンテナごと終わらせ、再起動は Docker に任せる。
set -euo pipefail
cd /home/worker/app
/home/worker/bin/release-orcad-lock.sh "$@"
node_modules/.bin/tsx src/main.ts &
if [ "$#" -gt 0 ]; then
	"$@" &
fi
set +e
wait -n
status=$?
kill $(jobs -p) 2>/dev/null
exit "$status"
