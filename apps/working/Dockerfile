# Working のコンテナ。orca serve と Claude CLI と Working 受付を同じコンテナで動かす。
# ビルドコンテキストはリポジトリルート: docker build -f apps/working/Dockerfile .
FROM node:24.22.1-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @yunomi/working... \
 && pnpm --filter @yunomi/working deploy --prod --legacy /out

FROM node:24.22.1-slim AS node

FROM debian:bookworm-slim

ARG ORCA_VERSION=1.4.248
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq bash procps \
	&& rm -rf /var/lib/apt/lists/*

# Claude CLI が clone・issue・PR に使う。認証は環境変数 GH_TOKEN で渡す。
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
		https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# 取り消せない操作を止める PreToolUse hook。managed settings も hook も root の持ち物にし、
# Claude CLI（worker で動く）が書き換えて止めるのをやめさせられないようにする。
COPY apps/working/guard/managed-settings.json /etc/claude-code/managed-settings.json
COPY apps/working/src/guard/hook.ts apps/working/src/guard/decide.ts \
	apps/working/src/guard/env.ts apps/working/src/guard/ledger.ts \
	apps/working/src/guard/bash.ts apps/working/src/guard/shell.ts \
	apps/working/src/guard/operation.ts /opt/yunomi-guard/

# Working の記憶の口を呼ぶ CLI。接続情報は受付が STATE_DIR に書き、この CLI の中でだけ読む。
COPY apps/working/src/memory-cli/cli.ts apps/working/src/memory-cli/bin.ts /opt/yunomi-memory/
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /opt/yunomi-memory/bin.ts "$@"\n' > /usr/local/bin/yunomi-memory \
	&& chmod 755 /usr/local/bin/yunomi-memory

# orca-ide の deb は Electron アプリ一式で、GUI 用ライブラリを依存に持つ。apt に解決させる。
RUN arch="$(dpkg --print-architecture)" \
	&& curl -fsSL -o /tmp/orca.deb \
		"https://github.com/stablyai/orca/releases/download/v${ORCA_VERSION}/orca-ide_${ORCA_VERSION}_${arch}.deb" \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends /tmp/orca.deb \
	&& rm -rf /var/lib/apt/lists/* /tmp/orca.deb

RUN useradd -m -s /bin/bash worker
USER worker
WORKDIR /home/worker
# named volume は空のときマウント先の所有者を引き継ぐ。先に worker 所有で作っておかないと root 所有になり書けない。
RUN mkdir -p /home/worker/.claude /home/worker/.config /home/worker/state /home/worker/work

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN git config --global credential.helper '!gh auth git-credential'
ENV PATH=/home/worker/.local/bin:$PATH
# .claude.json（ログインの付随情報）も volume に入れるため、設定の置き場所を 1 か所にまとめる。
ENV CLAUDE_CONFIG_DIR=/home/worker/.claude

# 人格の元ファイルをそのまま連結して system prompt にする。build context はリポジトリの root。
COPY --chown=worker:worker partners/yukarin/profile.yaml partners/yukarin/examples.yaml /home/worker/persona/
COPY --chown=worker:worker partners/yukarin/identity/ /home/worker/persona/identity/
COPY --chown=worker:worker apps/working/persona.sh /home/worker/bin/persona.sh
# Mac への引き継ぎの手順と申し送りの雛形。受付が起動時に system prompt の後ろに足す。
COPY apps/working/handoff/prompt.md apps/working/handoff/issue-template.md /home/worker/handoff/

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=worker:worker /out /home/worker/app
COPY --chown=worker:worker apps/working/start.sh apps/working/release-orcad-lock.sh /home/worker/bin/

# 8080 は gateway からの受付、8090 は Mac からの席の状態
EXPOSE 8080 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
# 引数（orca-ide serve …）を受付と並べて動かす。引数がなければ受付だけを動かす。
ENTRYPOINT ["/home/worker/bin/start.sh"]
