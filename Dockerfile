# syntax=docker/dockerfile:1.7
FROM node:24.13.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.0.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/common/package.json packages/common/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24.13.0-bookworm-slim AS runtime
WORKDIR /workspace
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/db ./db
COPY --from=build /workspace/agent-plugin ./agent-plugin
COPY --from=build /workspace/integration ./integration
USER node
CMD ["node", "dist/apps/api/src/index.js"]

FROM runtime AS integration-test
ENV NODE_ENV=test
