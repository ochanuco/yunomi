# ビルドコンテキストはリポジトリルート: docker build -f apps/gateway/Dockerfile .
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @yunomi/gateway... \
 && pnpm --filter @yunomi/gateway deploy --prod --legacy /out

FROM node:24-slim
ENV NODE_ENV=production
# VC で再生する WAV を ffmpeg で 48kHz ステレオへ変換する
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Gateway は HTTP を持たないため、heartbeat ファイルの更新時刻（90 秒以内）で生存を判定する
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "try{const f=process.env.HEARTBEAT_FILE||'/tmp/yunomi-gateway.heartbeat';process.exit(Date.now()-require('fs').statSync(f).mtimeMs<90000?0:1)}catch{process.exit(1)}"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
