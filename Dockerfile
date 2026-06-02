FROM docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS frontend-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM frontend-deps AS frontend-build
WORKDIR /app

COPY . .
RUN bun run build

FROM docker.io/library/golang:1.25.10-alpine@sha256:8d22e29d960bc50cd025d93d5b7c7d220b1ee9aa7a239b3c8f55a57e987e8d45 AS server-build
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
