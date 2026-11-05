#!/usr/bin/env bash
# 引数のコマンドを、席の Claude に渡してよい環境変数だけで動かす。
# YUNOMI_* は hook（src/guard）が席と許可の記録を探すのに使う。
set -euo pipefail
keep=(HOME PATH LANG LC_ALL TZ USER CLAUDE_CONFIG_DIR XDG_CONFIG_HOME GH_TOKEN
	GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL)
args=()
for k in "${keep[@]}"; do
	if [ -n "${!k:-}" ]; then args+=("$k=${!k}"); fi
done
args+=("YUNOMI_STATE_DIR=${STATE_DIR:-$HOME/state}")
args+=("YUNOMI_SEATS_DIR=${SEATS_DIR:-$HOME/work/orca/workspaces/seats}")
exec env -i "${args[@]}" "$@"
