FROM docker.io/oven/bun:1 AS frontend-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM frontend-deps AS frontend-build
WORKDIR /app

COPY . .
RUN bun run build

FROM docker.io/library/golang:1.23-alpine AS server-build
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -o /ganji-server ./cmd/server

FROM docker.io/library/alpine:3.22 AS runtime
WORKDIR /app

ENV PORT=3001

COPY --from=frontend-build /app/dist ./dist
COPY --from=server-build /ganji-server ./ganji-server

EXPOSE 3001

CMD ["./ganji-server"]
