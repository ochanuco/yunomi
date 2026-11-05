# Working の土台を確かめるためのコンテナ（K01）。orca serve と Claude CLI を同じコンテナで動かす。
FROM debian:bookworm-slim

ARG ORCA_VERSION=1.4.248
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq bash procps \
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
RUN mkdir -p /home/worker/.claude /home/worker/.config

RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH=/home/worker/.local/bin:$PATH
# .claude.json（ログインの付随情報）も volume に入れるため、設定の置き場所を 1 か所にまとめる。
ENV CLAUDE_CONFIG_DIR=/home/worker/.claude

# 人格の元ファイルをそのまま連結して system prompt にする。build context はリポジトリの root。
COPY --chown=worker:worker partners/yukarin/profile.yaml partners/yukarin/examples.yaml /home/worker/persona/
COPY --chown=worker:worker partners/yukarin/identity/ /home/worker/persona/identity/
COPY --chown=worker:worker apps/working/persona.sh /home/worker/bin/persona.sh
