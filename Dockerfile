FROM docker.io/oven/bun:1.3.3@sha256:fbf8e67e9d3b806c86be7a2f2e9bae801f2d9212a21db4dcf8cc9889f5a3c9c4 AS frontend-deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM frontend-deps AS frontend-build
WORKDIR /app

COPY . .
RUN bun run build

FROM docker.io/library/golang:1.26.3-alpine@sha256:91eda9776261207ea25fd06b5b7fed8d397dd2c0a283e77f2ab6e91bfa71079d AS server-build
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
