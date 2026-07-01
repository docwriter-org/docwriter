FROM node:22-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ENV DOCWRITER_HOSTED=1
ENV PUBLIC_DOCWRITER_HOSTED=1

RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI, which is used by the Claude Agent SDK.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

ENV NODE_ENV=production
ENV DOCWRITER_HOSTED=1
ENV PUBLIC_DOCWRITER_HOSTED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server.js ./server.js

EXPOSE 3000

CMD ["node", "server.js"]
