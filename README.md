# Ganji

A local browser version of Ganji built with React, TypeScript, Vite, and Bun.

## Run Locally

```sh
bun install
bun run dev
```

If Bun is not in your shell path yet, use:

```sh
~/.bun/bin/bun run dev
```

Then open the local URL shown by Vite.

## Scripts

```sh
bun run dev
bun run dev:server
bun run build
bun run lint
bun run preview
bun run server
```

## Run Online Multiplayer Locally

Use two terminals during development:

```sh
bun run dev:server
```

```sh
bun run dev
```

Open the Vite URL, switch `Play mode` to `Online`, then create or join a room.
The host chooses a 30, 60, 90, or 120 second turn timer when creating the room.

For production-style local testing:

```sh
bun run build
bun run server
```

Then open:

```txt
http://localhost:3001
```

The server hosts both the built web app and the WebSocket endpoint at `/ws`.
Online rooms require all connected humans to mark ready before the host can start.
The host and BOT players are always ready, and the host can kick human players from the lobby.
Kicked players can join again with the room code.

## Deploy Online

Deploy this project to a host that supports Bun and WebSockets. Set the start command to:

```sh
bun run build && bun run server
```

If the host builds separately, use:

```sh
bun run build
```

and set the runtime start command to:

```sh
bun run server
```

The app uses in-memory rooms for now. Rooms disappear if the server restarts.

## Implemented Rules

- Standard 52-card deck.
- Three to six players.
- Human and BOT players.
- Four cards dealt to each player at the start of each round.
- Card values: Ace 1, number cards face value, Jack 11, Queen 12, King 13.
- King of spades and king of clubs are worth 0.
- Each turn discards one card or multiple cards with the same value, then draws one card.
- Draw source is the main deck or the last discarded card from the previous player.
- If the deck runs out, buried discards are shuffled back into the deck while the latest discard remains available.
- A player may call GANJI only as the first action of their turn.
- A player must have hand value 5 or less to call GANJI.
- Online rooms use a host-selected turn timer and auto-play a discard or draw when time expires.
- Online joined humans must mark ready before the host can start; host and BOTs are always ready.
- Online hosts can kick human players from the lobby, and kicked players can rejoin by room code.
- Successful GANJI gives the caller 0 round points when they have or share the lowest hand value.
- Failed GANJI gives the caller their hand value plus 25 penalty points.
- Game ends when any player reaches 100 or more total points; lowest total score wins.

Game state is saved in `localStorage`, so refreshing the browser resumes the current game.
