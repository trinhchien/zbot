FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/scheduler/package.json apps/scheduler/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/scheduler/node_modules ./apps/scheduler/node_modules
COPY . .
RUN pnpm --filter @reunion/shared build \
 && pnpm --filter @reunion/db build \
 && pnpm --filter @reunion/scheduler build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/scheduler/dist ./apps/scheduler/dist
COPY --from=build /app/apps/scheduler/package.json ./apps/scheduler/
USER node
CMD ["node", "apps/scheduler/dist/index.js"]
