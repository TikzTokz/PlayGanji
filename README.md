# Ganji

Online-only Ganji built with a React, TypeScript, and Vite frontend plus an authoritative Go server.

The Go server owns rooms, hands, turns, scores, BOT actions, reconnects, and timeouts. It also serves the built frontend in production.

## Requirements

- Bun for frontend dependencies, Vite, linting, and frontend tests.
- Go 1.23 or newer for the server.
- Docker and Docker Compose are optional for production-style deployment.

## Run Locally

Install frontend dependencies:

```sh
bun install
```

Run the Go server in one terminal:

```sh
bun run dev:server
```

Run Vite in another terminal:

```sh
bun run dev
```

Open the local URL shown by Vite. In development, the frontend connects to the WebSocket server at `ws://localhost:3001/ws` unless `VITE_WS_URL` is set.

## Production-Style Local Run

Build the frontend and run the Go server:

```sh
bun run build
bun run server
```

Then open:

```txt
http://localhost:3001
```

The Go server serves `dist`, `/ws`, `/health`, and `/api/reconnect-check` from the same port.

## Scripts

```sh
bun run dev        # Start Vite for frontend development
bun run dev:server # Run the Go server with go run
bun run build      # Type-check and build the frontend into dist
bun run test       # Run frontend Vitest tests
bun run test:go    # Run Go tests for cmd and internal packages
bun run lint       # Run ESLint
bun run server     # Run the Go server with go run
bun run start      # Same as bun run server
bun run preview    # Preview the Vite frontend only
```

## Online Rooms

Players create or join rooms directly from the app. There is no local/pass-and-play mode.

Room behavior:

- Friends join with a room code.
- The host chooses a 30, 60, 90, or 120 second turn timer.
- The host chooses a 50, 100, 150, or 200 point end-game limit.
- Connected humans must mark ready before the host can start.
- The host and BOT players are always ready.
- The host can add BOTs, remove BOTs, kick humans from the lobby, delete the room, or leave without deleting.
- Kicked players can join again with the room code before the game starts.
- During a round, each client only receives their own hand; other hands, deck cards, and buried discards are redacted.

## Reconnects

The app saves the player name and reconnect session in `localStorage`.

Reconnect behavior:

- On page load, the frontend checks `/api/reconnect-check` before showing a saved-room reconnect prompt.
- The reconnect prompt is shown only when the room still exists and the saved session matches a player seat.
- If the room or session is invalid, the saved reconnect session is cleared.
- If a player is accidentally disconnected while in a room, the frontend keeps the last room view and automatically retries `REJOIN_ROOM` with backoff.
- If the user intentionally leaves, auto-reconnect is disabled.
- If a room is deleted or closed, the saved reconnect session is cleared.

Rooms are stored in memory. Rooms disappear when the server process restarts and are automatically removed after 15 minutes with no connected human players.

## Server Endpoints

- `GET /` serves the built frontend from `dist`.
- `GET /ws` upgrades to the multiplayer WebSocket.
- `GET /health` returns server health and active room count.
- `POST /api/reconnect-check` validates a saved `{ roomCode, sessionId }` before the frontend shows a reconnect prompt.

## Deploy

Recommended deployment is Docker Compose.

The Docker image uses Bun to build the frontend, Go to build the server binary, and Alpine for the runtime container. The runtime container only runs the Go server.

If deploying without Docker, build the frontend and run the Go server from the repository root:

```sh
bun install --frozen-lockfile
bun run build
go run ./cmd/server
```

Set `PORT` to change the server port. The default is `3001`.

If using Cloudflare Tunnel, it can point to the single Go service, for example:

```txt
http://127.0.0.1:3001
```

WebSockets are served at `/ws` on the same origin.

## Run With Docker

Build and start the production app with Docker Compose:

```sh
docker compose up --build
```

Then open:

```txt
http://localhost:3001
```

`docker-compose.yml` binds the app to `127.0.0.1:3001` by default.

Stop the container with:

```sh
docker compose down
```

## CI/CD

GitHub Actions runs on pushes to `main` and manual dispatches.

CI steps:

- Install Bun dependencies.
- Run ESLint.
- Run frontend tests.
- Run Go tests.
- Build the frontend.
- Build the Go server.

Deploy runs on the self-hosted runner from `/opt/PlayGanji` with Docker Compose and checks `/health` on `127.0.0.1:3001`.

## Implemented Rules

- Standard 52-card deck.
- Three to six players.
- Human and BOT players.
- Four cards dealt to each player at the start of each round.
- The first player rotates each round.
- Card values: Ace 1, number cards face value, Jack 11, Queen 12, King 13.
- King of spades and king of clubs are worth 0.
- Each turn discards one card or multiple cards with the same value, then draws one card.
- Draw source is the main deck or the last discarded card from the previous player.
- If the deck runs out, buried discards are shuffled back into the deck while the latest discard remains available.
- A player may call GANJI only as the first action of their turn.
- A player must have hand value 5 or less to call GANJI.
- Successful GANJI gives the caller 0 round points when they have or share the lowest hand value.
- Failed GANJI gives the caller their hand value plus 25 penalty points.
- The game ends when any player reaches the selected point limit or more; lowest total score wins.
- The server auto-plays a discard or draw when a turn timer expires.
- Disconnected humans get one timeout, then a BOT plays their seat until they rejoin.
