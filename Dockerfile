FROM docker.io/oven/bun:1.3.3@sha256:fbf8e67e9d3b806c86be7a2f2e9bae801f2d9212a21db4dcf8cc9889f5a3c9c4 AS frontend-deps
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

FROM docker.io/library/alpine:3.23@sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11 AS runtime
WORKDIR /app

ENV PORT=3001

RUN addgroup -S app && adduser -S app -G app

COPY --from=frontend-build /app/dist ./dist
COPY --from=server-build /ganji-server ./ganji-server

USER app

EXPOSE 3001

CMD ["./ganji-server"]
