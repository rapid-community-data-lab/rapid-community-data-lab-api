# Multi-stage build for rapid-community-data-lab-api (Fastify + Prisma).

# ---- Build stage ----
FROM node:24-alpine AS build
WORKDIR /app

# Install deps using the project's lockfile.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# Copy source then generate the Prisma client (no DB connection required).
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./
COPY src ./src
# Symlink arocapi shared models into prisma/ so generation can resolve them.
RUN ln -sfn ../node_modules/arocapi/prisma/models prisma/arocapi \
    && npx prisma generate

# ---- Runtime stage ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV RAPID_COMMUNITY_DATA_LAB_API_PORT=8080

# Tini gives us a proper PID 1 with signal handling.
RUN apk add --no-cache tini

# Copy installed deps and generated artefacts from the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/package.json ./
COPY --from=build /app/tsconfig.json ./

# Entrypoint waits for DB, runs schema push, then starts the server.
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${RAPID_COMMUNITY_DATA_LAB_API_PORT}/version" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "src/index.ts"]
