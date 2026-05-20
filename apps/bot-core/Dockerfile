FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/bot-core/package.json apps/bot-core/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/bot-core/node_modules ./apps/bot-core/node_modules
COPY . .
RUN pnpm --filter @reunion/shared build \
 && pnpm --filter @reunion/db build \
 && pnpm --filter @reunion/bot-core build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/bot-core/dist ./apps/bot-core/dist
COPY --from=build /app/apps/bot-core/package.json ./apps/bot-core/
USER node
CMD ["node", "apps/bot-core/dist/index.js"]
