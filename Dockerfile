FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile
FROM dependencies AS base
COPY . .
FROM base AS build
RUN pnpm build
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production BIND_HOST=0.0.0.0 TOKEN_FILE=/run/acornary/token
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/migrations ./migrations
COPY package.json ./
CMD ["node","dist/apps/server/src/index.js"]
FROM dependencies AS browser-test
RUN pnpm exec playwright install --with-deps chromium
COPY . .
CMD ["pnpm","test:e2e"]
