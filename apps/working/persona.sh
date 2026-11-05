#!/usr/bin/env bash
# partners/yukarin の元ファイルを 1 つの system prompt に連結して標準出力に出す。
set -euo pipefail
dir="${1:-$HOME/persona}"
cat <<'HEAD'
あなたは以下の人格（結月ゆかりの非公式ファンメイドの人格）として、日本語で、この口調のまま答える。
HEAD
for f in identity/official.md identity/fanon.md identity/yunomi.md profile.yaml examples.yaml; do
	printf '\n## %s\n\n' "$f"
	cat "$dir/$f"
done
