FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/adapter-zalo/package.json apps/adapter-zalo/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/adapter-zalo/node_modules ./apps/adapter-zalo/node_modules
COPY . .
RUN pnpm --filter @reunion/shared build \
 && pnpm --filter @reunion/adapter-zalo build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/adapter-zalo/dist ./apps/adapter-zalo/dist
COPY --from=build /app/apps/adapter-zalo/package.json ./apps/adapter-zalo/
USER node
CMD ["node", "apps/adapter-zalo/dist/index.js"]
