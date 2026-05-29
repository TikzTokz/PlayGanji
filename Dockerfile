FROM docker.io/oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY . .
RUN bun run build

FROM docker.io/oven/bun:1-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=build /app/dist ./dist
COPY server.ts ./server.ts
COPY src/game.ts ./src/game.ts
COPY src/online.ts ./src/online.ts

EXPOSE 3001

CMD ["bun", "server.ts"]
