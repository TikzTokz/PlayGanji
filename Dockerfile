FROM docker.io/oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS frontend-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM frontend-deps AS frontend-build
WORKDIR /app

COPY . .
RUN bun run build

FROM docker.io/library/golang:1.25.11-alpine@sha256:c05ba4b73604069d376c4f41346b05374335b5ca0c46fb6dfede5a59f5196931 AS server-build
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -o /ganji-server ./cmd/server

FROM docker.io/library/alpine:3.22@sha256:310c62b5e7ca5b08167e4384c68db0fd2905dd9c7493756d356e893909057601 AS runtime
WORKDIR /app

ENV PORT=3001

RUN addgroup -S app && adduser -S app -G app

COPY --from=frontend-build /app/dist ./dist
COPY --from=server-build /ganji-server ./ganji-server

USER app

EXPOSE 3001

CMD ["./ganji-server"]
