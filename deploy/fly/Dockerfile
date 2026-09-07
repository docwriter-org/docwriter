# Hosted DocWriter on Fly.io: the supervisor plus one sandboxed DocWriter
# process per user, in one Fly Machine (a Firecracker VM) with a volume at
# /data. Build context is the repository root:
#   fly deploy . --config deploy/fly/fly.toml --dockerfile deploy/fly/Dockerfile
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev \
  # glibc image: drop the musl build of the Claude Agent SDK's CLI (same as CI)
  && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl

FROM node:22-bookworm-slim
ARG LITESTREAM_VERSION=0.3.13
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git bubblewrap rclone procps util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" -o /tmp/litestream.deb \
  && dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/bin ./bin
COPY --from=build /app/deploy ./deploy
COPY --from=build /app/package.json ./package.json
# Every user uid must be able to read the app; bubblewrap binds it read-only.
RUN chmod -R a+rX /app && chmod +x /app/deploy/fly/entrypoint.sh /app/deploy/backup/backup.sh
ENV NODE_ENV=production \
    SUPERVISOR_APP_DIR=/app \
    SUPERVISOR_DATA_DIR=/data \
    SUPERVISOR_BIND=0.0.0.0 \
    SUPERVISOR_PORT=8080 \
    SUPERVISOR_SANDBOX=bwrap \
    SUPERVISOR_AUTH=clerk \
    SUPERVISOR_ALLOWLIST=/data/allowlist
EXPOSE 8080
ENTRYPOINT ["/app/deploy/fly/entrypoint.sh"]
