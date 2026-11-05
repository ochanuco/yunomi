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

# Mac への引き継ぎで push と issue の作成に使う。Debian の gh は古いので GitHub の apt リポジトリから入れる。
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

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
# git の push は GH_TOKEN を gh 経由で使う。トークンをファイルに書かない。
RUN git config --global credential.https://github.com.helper '!gh auth git-credential' \
	&& git config --global user.name "Yukarin (Working)" \
	&& git config --global user.email "working@yunomi.invalid"

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/home/worker/.local/bin:$PATH
# .claude.json（ログインの付随情報）も volume に入れるため、設定の置き場所を 1 か所にまとめる。
ENV CLAUDE_CONFIG_DIR=/home/worker/.claude

# 人格の元ファイルをそのまま連結して system prompt にする。build context はリポジトリの root。
COPY --chown=worker:worker partners/yukarin/profile.yaml partners/yukarin/examples.yaml /home/worker/persona/
COPY --chown=worker:worker partners/yukarin/identity/ /home/worker/persona/identity/
COPY --chown=worker:worker apps/working/persona.sh /home/worker/bin/persona.sh
COPY --chown=worker:worker apps/working/handoff/prompt.md apps/working/handoff/issue-template.md /home/worker/handoff/

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=worker:worker /out /home/worker/app
COPY --chown=worker:worker apps/working/start.sh /home/worker/bin/start.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
# 引数（orca-ide serve …）を受付と並べて動かす。引数がなければ受付だけを動かす。
ENTRYPOINT ["/home/worker/bin/start.sh"]
