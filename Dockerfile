# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
ARG PNPM_VERSION=10.28.2
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install --global "pnpm@${PNPM_VERSION}" \
    && test "$(pnpm --version)" = "$PNPM_VERSION"
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgres://build:build@127.0.0.1:5432/openvac_build"
ENV APP_URL="http://127.0.0.1:3000"
ENV NEXT_PUBLIC_APP_URL="http://127.0.0.1:3000"
ENV BETTER_AUTH_URL="http://127.0.0.1:3000"
ENV BETTER_AUTH_SECRET="build-only-secret-with-at-least-32-characters"
RUN pnpm build

FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/package.json /app/pnpm-lock.yaml ./
COPY --from=builder --chown=nextjs:nodejs /app/drizzle.config.ts /app/tsconfig.json ./
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=nextjs:nodejs /app/knowledge ./knowledge
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
