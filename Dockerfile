FROM oven/bun:1.3.8-slim AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.8-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/bot.sqlite

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock index.ts ./
COPY src ./src

RUN mkdir -p /app/data && chown -R bun:bun /app

USER bun

VOLUME ["/app/data"]

CMD ["bun", "index.ts"]
