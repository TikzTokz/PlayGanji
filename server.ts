import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  calculateHandValue,
  chooseBotDiscard,
  chooseBotDrawSource,
  gameReducer,
  initialGameState,
  type Card,
  type GameAction,
  type GameState,
  type Player,
  type SetupPlayerConfig,
  normalizeGameOverScore,
} from './src/game'
import type {
  ClientToServerMessage,
  OnlineLobbyPlayer,
  OnlineRoomStatus,
  OnlineRoomView,
  ServerToClientMessage,
} from './src/online'

type SocketData = {
  socketId: string
  roomCode?: string
  playerId?: string
  sessionId?: string
}

type ServerSocket = Bun.ServerWebSocket<SocketData>

type ServerPlayer = OnlineLobbyPlayer & {
  sessionId?: string
  disconnectedTimeoutUsed: boolean
}

type ServerRoom = {
  roomCode: string
  hostPlayerId: string
  players: ServerPlayer[]
  gameState: GameState | null
  sockets: Map<string, ServerSocket>
  nextPlayerNumber: number
  nextBotNumber: number
  botTimer: ReturnType<typeof setTimeout> | null
  turnTimer: ReturnType<typeof setTimeout> | null
  inactiveCleanupTimer: ReturnType<typeof setTimeout> | null
  turnTimerSeconds: number
  gameOverScore: number
  turnDeadline: number | null
  turnTimerKey: string | null
  message: string
}

const rooms = new Map<string, ServerRoom>()
const port = Number(Bun.env.PORT ?? 3001)
const INACTIVE_ROOM_TIMEOUT_MS = 15 * 60 * 1000

Bun.serve<SocketData>({
  port,
  async fetch(request, server) {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(request, {
        data: { socketId: createId() },
      })

      return upgraded
        ? undefined
        : new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, rooms: rooms.size })
    }

    return serveStaticAsset(url.pathname)
  },
  websocket: {
    open(socket) {
      socket.send(
        JSON.stringify({
          type: 'ERROR',
          message: 'Connected. Create or join a room.',
        } satisfies ServerToClientMessage),
      )
    },
    message(socket, rawMessage) {
      handleSocketMessage(socket, rawMessage)
    },
    close(socket) {
      detachSocket(socket)
    },
  },
})

console.log(`Ganji server listening on http://localhost:${port}`)

async function serveStaticAsset(pathname: string): Promise<Response> {
  const cleanPathname = decodeURIComponent(pathname).replaceAll('..', '')
  const filePath = cleanPathname === '/' ? '/index.html' : cleanPathname
  const file = Bun.file(`dist${filePath}`)

  if (await file.exists()) {
    return new Response(file)
  }

  const fallback = Bun.file('dist/index.html')
  if (await fallback.exists()) {
    return new Response(fallback)
  }

  return new Response(
    'Ganji multiplayer server is running. Build the client with `bun run build` to serve it here.',
    { headers: { 'content-type': 'text/plain' } },
  )
}

function handleSocketMessage(socket: ServerSocket, rawMessage: string | Buffer) {
  let message: ClientToServerMessage

  try {
    message = JSON.parse(rawMessage.toString()) as ClientToServerMessage
  } catch {
    sendError(socket, 'Invalid message format.')
    return
  }

  switch (message.type) {
    case 'CREATE_ROOM':
      createRoom(socket, message.name, message.turnTimerSeconds, message.gameOverScore)
      return
    case 'JOIN_ROOM':
      joinRoom(socket, message.roomCode, message.name)
      return
    case 'REJOIN_ROOM':
      rejoinRoom(socket, message.roomCode, message.sessionId)
      return
    case 'ADD_BOT':
      addBot(socket)
      return
    case 'REMOVE_BOT':
      removeBot(socket, message.playerId)
      return
    case 'SET_READY':
      setReady(socket, message.ready)
      return
    case 'KICK_PLAYER':
      kickPlayer(socket, message.playerId)
      return
    case 'DELETE_ROOM':
      deleteRoom(socket)
      return
    case 'START_GAME':
      startGame(socket)
      return
    case 'DISCARD_CARDS':
      applyPlayerAction(socket, { type: 'DISCARD_CARDS', cardIds: message.cardIds })
      return
    case 'DRAW_CARD':
      applyPlayerAction(socket, { type: 'DRAW_CARD', source: message.source })
      return
    case 'CALL_GANJI':
      applyPlayerAction(socket, { type: 'CALL_GANJI' })
      return
    case 'END_TURN':
      applyPlayerAction(socket, { type: 'END_TURN' })
      return
    case 'START_NEXT_ROUND':
      applyRoomAction(socket, { type: 'START_NEXT_ROUND' })
      return
  }
}

function createRoom(
  socket: ServerSocket,
  name: string,
  turnTimerSeconds: number,
  gameOverScore: number,
) {
  detachSocket(socket)

  const roomCode = createRoomCode()
  const sessionId = createId()
  const player: ServerPlayer = {
    id: 'player-1',
    name: normalizeName(name, 'Host'),
    isBot: false,
    connected: true,
    ready: true,
    substituteActive: false,
    disconnectedTimeoutUsed: false,
    sessionId,
  }
  const room: ServerRoom = {
    roomCode,
    hostPlayerId: player.id,
    players: [player],
    gameState: null,
    sockets: new Map(),
    nextPlayerNumber: 2,
    nextBotNumber: 1,
    botTimer: null,
    turnTimer: null,
    inactiveCleanupTimer: null,
    turnTimerSeconds: normalizeTurnTimerSeconds(turnTimerSeconds),
    gameOverScore: normalizeGameOverScore(gameOverScore),
    turnDeadline: null,
    turnTimerKey: null,
    message: `Room ${roomCode} created. Share the code with friends.`,
  }

  rooms.set(roomCode, room)
  attachSocket(socket, room, player, sessionId)
  broadcastRoom(room)
}

function joinRoom(socket: ServerSocket, roomCodeInput: string, name: string) {
  detachSocket(socket)

  const roomCode = roomCodeInput.trim().toUpperCase()
  const room = rooms.get(roomCode)

  if (!room) {
    sendError(socket, 'Room not found.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'This room already started. Rejoin with your saved session instead.')
    return
  }

  if (room.players.length >= MAX_PLAYERS) {
    sendError(socket, 'This room is full.')
    return
  }

  const sessionId = createId()
  const player: ServerPlayer = {
    id: `player-${room.nextPlayerNumber}`,
    name: normalizeName(name, `Player ${room.nextPlayerNumber}`),
    isBot: false,
    connected: true,
    ready: false,
    substituteActive: false,
    disconnectedTimeoutUsed: false,
    sessionId,
  }

  room.nextPlayerNumber += 1
  room.players.push(player)
  room.message = `${player.name} joined the room.`
  attachSocket(socket, room, player, sessionId)
  broadcastRoom(room)
}

function rejoinRoom(
  socket: ServerSocket,
  roomCodeInput: string,
  sessionId: string,
) {
  detachSocket(socket)

  const room = rooms.get(roomCodeInput.trim().toUpperCase())
  if (!room) {
    sendError(socket, 'Room not found.')
    return
  }

  const player = room.players.find((candidate) => candidate.sessionId === sessionId)
  if (!player) {
    sendError(socket, 'Saved session was not found for this room.')
    return
  }

  room.message = `${player.name} reconnected.`
  attachSocket(socket, room, player, sessionId)
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function addBot(socket: ServerSocket) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before adding bots.')
    return
  }

  if (!isHost(socket, room)) {
    sendError(socket, 'Only the host can add bots.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'Bots can only be added before the game starts.')
    return
  }

  if (room.players.length >= MAX_PLAYERS) {
    sendError(socket, 'This room is already full.')
    return
  }

  const bot: ServerPlayer = {
    id: `player-${room.nextPlayerNumber}`,
    name: `BOT ${room.nextBotNumber}`,
    isBot: true,
    connected: true,
    ready: true,
    substituteActive: false,
    disconnectedTimeoutUsed: false,
  }

  room.nextPlayerNumber += 1
  room.nextBotNumber += 1
  room.players.push(bot)
  room.message = `${bot.name} joined the table.`
  broadcastRoom(room)
}

function removeBot(socket: ServerSocket, playerId: string) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before removing bots.')
    return
  }

  if (!isHost(socket, room)) {
    sendError(socket, 'Only the host can remove bots.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'Bots can only be removed before the game starts.')
    return
  }

  const bot = room.players.find((player) => player.id === playerId && player.isBot)
  if (!bot) {
    sendError(socket, 'Bot not found.')
    return
  }

  room.players = room.players.filter((player) => player.id !== playerId)
  room.message = `${bot.name} left the table.`
  broadcastRoom(room)
}

function setReady(socket: ServerSocket, ready: boolean) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before changing ready status.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'Ready status can only be changed before the game starts.')
    return
  }

  const player = room.players.find((candidate) => candidate.id === socket.data.playerId)
  if (!player) {
    sendError(socket, 'Player not found.')
    return
  }

  if (player.id === room.hostPlayerId || player.isBot) {
    player.ready = true
  } else {
    player.ready = ready
  }

  room.message = `${player.name} is ${player.ready ? 'ready' : 'not ready'}.`
  broadcastRoom(room)
}

function kickPlayer(socket: ServerSocket, playerId: string) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before kicking players.')
    return
  }

  if (!isHost(socket, room)) {
    sendError(socket, 'Only the host can kick players.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'Players can only be kicked before the game starts.')
    return
  }

  const player = room.players.find((candidate) => candidate.id === playerId)
  if (!player || player.isBot || player.id === room.hostPlayerId) {
    sendError(socket, 'That player cannot be kicked.')
    return
  }

  for (const playerSocket of room.sockets.values()) {
    if (playerSocket.data.playerId === player.id) {
      sendError(playerSocket, 'You were kicked from the room. You can rejoin with the room code.')
      playerSocket.data.roomCode = undefined
      playerSocket.data.playerId = undefined
      playerSocket.data.sessionId = undefined
      room.sockets.delete(playerSocket.data.socketId)
    }
  }

  room.players = room.players.filter((candidate) => candidate.id !== player.id)
  room.message = `${player.name} was kicked from the room.`
  updateConnectionFlags(room)
  broadcastRoom(room)
}

function deleteRoom(socket: ServerSocket) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before deleting it.')
    return
  }

  if (!isHost(socket, room)) {
    sendError(socket, 'Only the host can delete this room.')
    return
  }

  const host = room.players.find((player) => player.id === room.hostPlayerId)
  closeRoom(room, `${host?.name ?? 'The host'} deleted room ${room.roomCode}.`)
}

function startGame(socket: ServerSocket) {
  const room = getSocketRoom(socket)
  if (!room) {
    sendError(socket, 'Join a room before starting a game.')
    return
  }

  if (!isHost(socket, room)) {
    sendError(socket, 'Only the host can start the game.')
    return
  }

  if (getRoomStatus(room) !== 'lobby') {
    sendError(socket, 'The game already started.')
    return
  }

  if (room.players.length < MIN_PLAYERS) {
    sendError(socket, `Ganji needs at least ${MIN_PLAYERS} players or bots.`)
    return
  }

  updateConnectionFlags(room)

  const disconnectedPlayer = room.players.find(
    (player) => !player.isBot && !player.connected,
  )
  if (disconnectedPlayer) {
    sendError(socket, `${disconnectedPlayer.name} must reconnect before the game starts.`)
    return
  }

  if (!room.players.every((player) => player.ready)) {
    sendError(socket, 'Every player must be ready before the game starts.')
    return
  }

  const setupPlayers: SetupPlayerConfig[] = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    isBot: player.isBot,
  }))

  room.gameState = gameReducer(initialGameState, {
    type: 'START_GAME',
    players: setupPlayers,
    gameOverScore: room.gameOverScore,
  })
  room.message = 'Game started.'
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function applyPlayerAction(socket: ServerSocket, action: GameAction) {
  const room = getSocketRoom(socket)
  if (!room?.gameState) {
    sendError(socket, 'The game has not started.')
    return
  }

  const currentPlayer = getCurrentPlayer(room.gameState)
  if (!currentPlayer) {
    sendError(socket, 'No current player found.')
    return
  }

  if (isServerControlledPlayer(room, currentPlayer)) {
    sendError(socket, 'The server controls this turn.')
    return
  }

  if (currentPlayer.id !== socket.data.playerId) {
    sendError(socket, `It is ${currentPlayer.name}'s turn.`)
    return
  }

  room.gameState = gameReducer(room.gameState, action)
  room.message = room.gameState.message
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function applyRoomAction(socket: ServerSocket, action: GameAction) {
  const room = getSocketRoom(socket)
  if (!room?.gameState) {
    sendError(socket, 'The game has not started.')
    return
  }

  room.gameState = gameReducer(room.gameState, action)
  room.message = room.gameState.message
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function scheduleBotTurn(room: ServerRoom) {
  if (
    room.botTimer ||
    !hasConnectedHuman(room) ||
    !room.gameState ||
    room.gameState.status !== 'playing'
  ) {
    return
  }

  const currentPlayer = getCurrentPlayer(room.gameState)
  if (!currentPlayer || !isServerControlledPlayer(room, currentPlayer)) {
    return
  }

  room.botTimer = setTimeout(() => {
    room.botTimer = null
    processBotTurn(room)
  }, 700)
}

function processBotTurn(room: ServerRoom) {
  const gameState = room.gameState
  if (!gameState || gameState.status !== 'playing') {
    return
  }

  const currentPlayer = getCurrentPlayer(gameState)
  if (!currentPlayer || !isServerControlledPlayer(room, currentPlayer)) {
    return
  }

  const handValue = calculateHandValue(currentPlayer.hand)
  let action: GameAction

  if (gameState.phase === 'discard' && handValue <= 5) {
    action = { type: 'CALL_GANJI' }
  } else if (gameState.phase === 'discard') {
    action = {
      type: 'DISCARD_CARDS',
      cardIds: chooseBotDiscard(currentPlayer.hand).map((card) => card.id),
    }
  } else if (gameState.phase === 'draw') {
    action = { type: 'DRAW_CARD', source: chooseBotDrawSource(gameState) }
  } else {
    action = { type: 'END_TURN' }
  }

  room.gameState = gameReducer(gameState, action)
  room.message = room.gameState.message
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function startTurnTimer(room: ServerRoom) {
  clearTurnTimer(room)

  if (!hasConnectedHuman(room) || !room.gameState || room.gameState.status !== 'playing') {
    room.turnDeadline = null
    room.turnTimerKey = null
    return
  }

  const currentPlayer = getCurrentPlayer(room.gameState)
  if (!currentPlayer) {
    room.turnDeadline = null
    room.turnTimerKey = null
    return
  }

  room.turnTimerKey = createTurnTimerKey(room.gameState)
  room.turnDeadline = Date.now() + room.turnTimerSeconds * 1000
  room.turnTimer = setTimeout(() => {
    processTurnTimeout(room, room.turnTimerKey)
  }, room.turnTimerSeconds * 1000)
}

function processTurnTimeout(room: ServerRoom, turnTimerKey: string | null) {
  room.turnTimer = null

  if (
    !room.gameState ||
    room.gameState.status !== 'playing' ||
    !turnTimerKey ||
    createTurnTimerKey(room.gameState) !== turnTimerKey
  ) {
    return
  }

  const currentPlayer = getCurrentPlayer(room.gameState)
  if (!currentPlayer) {
    return
  }

  const serverPlayer = getServerPlayer(room, currentPlayer.id)
  const action = createTimeoutAction(room.gameState, currentPlayer)
  room.gameState = gameReducer(room.gameState, action)

  const shouldStartSubstitute =
    serverPlayer &&
    !serverPlayer.isBot &&
    !serverPlayer.connected &&
    !serverPlayer.substituteActive

  if (shouldStartSubstitute) {
    serverPlayer.substituteActive = true
    serverPlayer.disconnectedTimeoutUsed = true
  }

  room.message = shouldStartSubstitute
    ? `${currentPlayer.name} ran out of time. A BOT is now playing their seat. ${room.gameState.message}`
    : `${currentPlayer.name} ran out of time. ${room.gameState.message}`
  startTurnTimer(room)
  broadcastRoom(room)
  scheduleBotTurn(room)
}

function createTimeoutAction(
  gameState: GameState,
  currentPlayer: Player,
): GameAction {
  if (gameState.phase === 'discard') {
    return {
      type: 'DISCARD_CARDS',
      cardIds: chooseBotDiscard(currentPlayer.hand).map((card) => card.id),
    }
  }

  if (gameState.phase === 'draw') {
    return { type: 'DRAW_CARD', source: chooseBotDrawSource(gameState) }
  }

  return { type: 'END_TURN' }
}

function clearTurnTimer(room: ServerRoom) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer)
    room.turnTimer = null
  }
}

function clearBotTimer(room: ServerRoom) {
  if (room.botTimer) {
    clearTimeout(room.botTimer)
    room.botTimer = null
  }
}

function clearInactiveCleanupTimer(room: ServerRoom) {
  if (room.inactiveCleanupTimer) {
    clearTimeout(room.inactiveCleanupTimer)
    room.inactiveCleanupTimer = null
  }
}

function closeRoom(room: ServerRoom, message: string) {
  clearBotTimer(room)
  clearTurnTimer(room)
  clearInactiveCleanupTimer(room)
  rooms.delete(room.roomCode)

  for (const socket of room.sockets.values()) {
    socket.send(
      JSON.stringify({
        type: 'ROOM_CLOSED',
        roomCode: room.roomCode,
        message,
      } satisfies ServerToClientMessage),
    )
    socket.data.roomCode = undefined
    socket.data.playerId = undefined
    socket.data.sessionId = undefined
  }

  room.sockets.clear()
}

function createTurnTimerKey(gameState: GameState): string {
  const currentPlayer = getCurrentPlayer(gameState)
  return `${gameState.roundNumber}:${gameState.currentPlayerIndex}:${currentPlayer?.id ?? 'none'}:${gameState.phase}`
}

function attachSocket(
  socket: ServerSocket,
  room: ServerRoom,
  player: ServerPlayer,
  sessionId: string,
) {
  socket.data.roomCode = room.roomCode
  socket.data.playerId = player.id
  socket.data.sessionId = sessionId
  room.sockets.set(socket.data.socketId, socket)
  player.substituteActive = false
  player.disconnectedTimeoutUsed = false
  updateConnectionFlags(room)
  updateInactiveCleanup(room)
}

function detachSocket(socket: ServerSocket) {
  const room = getSocketRoom(socket)
  if (!room) {
    return
  }

  room.sockets.delete(socket.data.socketId)
  updateConnectionFlags(room)

  const player = room.players.find((candidate) => candidate.id === socket.data.playerId)
  if (player && !player.connected) {
    player.substituteActive = false
    player.disconnectedTimeoutUsed = false
    room.message = `${player.name} disconnected.`
  }

  socket.data.roomCode = undefined
  socket.data.playerId = undefined
  socket.data.sessionId = undefined

  if (!hasConnectedHuman(room)) {
    clearBotTimer(room)
    clearTurnTimer(room)
    room.turnDeadline = null
    room.turnTimerKey = null
  }

  updateInactiveCleanup(room)
  broadcastRoom(room)
}

function updateInactiveCleanup(room: ServerRoom) {
  if (hasConnectedHuman(room)) {
    clearInactiveCleanupTimer(room)
    return
  }

  if (room.inactiveCleanupTimer) {
    return
  }

  room.inactiveCleanupTimer = setTimeout(() => {
    const inactiveRoom = rooms.get(room.roomCode)
    if (!inactiveRoom) {
      return
    }

    updateConnectionFlags(inactiveRoom)
    if (!hasConnectedHuman(inactiveRoom)) {
      closeRoom(inactiveRoom, `Room ${inactiveRoom.roomCode} was removed after 15 minutes of inactivity.`)
    }
  }, INACTIVE_ROOM_TIMEOUT_MS)
}

function broadcastRoom(room: ServerRoom) {
  updateConnectionFlags(room)

  for (const socket of room.sockets.values()) {
    sendRoomUpdate(socket, room)
  }
}

function sendRoomUpdate(socket: ServerSocket, room: ServerRoom) {
  const playerId = socket.data.playerId
  const sessionId = socket.data.sessionId

  if (!playerId || !sessionId) {
    return
  }

  socket.send(
    JSON.stringify({
      type: 'ROOM_UPDATE',
      sessionId,
      room: createRoomView(room, playerId),
    } satisfies ServerToClientMessage),
  )
}

function createRoomView(
  room: ServerRoom,
  viewerPlayerId: string,
): OnlineRoomView {
  return {
    roomCode: room.roomCode,
    status: getRoomStatus(room),
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      isBot: player.isBot,
      connected: player.connected,
      ready: player.ready,
      substituteActive: player.substituteActive,
    })),
    gameState: room.gameState ? redactGameState(room.gameState, viewerPlayerId) : null,
    viewerPlayerId,
    hostPlayerId: room.hostPlayerId,
    turnTimerSeconds: room.turnTimerSeconds,
    gameOverScore: room.gameOverScore,
    turnDeadline: room.turnDeadline,
    message: room.message,
  }
}

function redactGameState(
  gameState: GameState,
  viewerPlayerId: string,
): GameState {
  const revealAllHands = gameState.status !== 'playing'

  return {
    ...gameState,
    players: gameState.players.map((player) => ({
      ...player,
      hand:
        revealAllHands || player.id === viewerPlayerId
          ? player.hand
          : createHiddenCards(player.hand.length, player.id),
    })),
    deck: createHiddenCards(gameState.deck.length, 'deck'),
    discardPile: createHiddenCards(gameState.discardPile.length, 'discard'),
  }
}

function createHiddenCards(count: number, owner: string): Card[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hidden-${owner}-${index}`,
    rank: 'A',
    suit: 'spades',
    value: 0,
  }))
}

function updateConnectionFlags(room: ServerRoom) {
  for (const player of room.players) {
    if (player.isBot || player.id === room.hostPlayerId) {
      player.ready = true
    }

    player.connected =
      player.isBot ||
      Array.from(room.sockets.values()).some(
        (socket) => socket.data.playerId === player.id,
      )
  }
}

function getSocketRoom(socket: ServerSocket): ServerRoom | null {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) ?? null : null
}

function getCurrentPlayer(gameState: GameState): Player | null {
  return gameState.players[gameState.currentPlayerIndex] ?? null
}

function getServerPlayer(room: ServerRoom, playerId: string): ServerPlayer | null {
  return room.players.find((player) => player.id === playerId) ?? null
}

function isServerControlledPlayer(room: ServerRoom, player: Player): boolean {
  const serverPlayer = getServerPlayer(room, player.id)
  return Boolean(
    player.isBot ||
      serverPlayer?.isBot ||
      (serverPlayer?.substituteActive && !serverPlayer.connected),
  )
}

function hasConnectedHuman(room: ServerRoom): boolean {
  return room.players.some((player) => !player.isBot && player.connected)
}

function getRoomStatus(room: ServerRoom): OnlineRoomStatus {
  if (!room.gameState) {
    return 'lobby'
  }

  return room.gameState.status === 'setup' ? 'lobby' : room.gameState.status
}

function isHost(socket: ServerSocket, room: ServerRoom): boolean {
  return socket.data.playerId === room.hostPlayerId
}

function sendError(socket: ServerSocket, message: string) {
  socket.send(JSON.stringify({ type: 'ERROR', message } satisfies ServerToClientMessage))
}

function createRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code: string

  do {
    code = Array.from(
      { length: 6 },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join('')
  } while (rooms.has(code))

  return code
}

function createId(): string {
  return crypto.randomUUID()
}

function normalizeName(name: string, fallback: string): string {
  const trimmedName = name.trim()
  return trimmedName.length > 0 ? trimmedName : fallback
}

function normalizeTurnTimerSeconds(turnTimerSeconds: number): number {
  const allowedTimers = [30, 60, 90, 120]
  return allowedTimers.includes(turnTimerSeconds) ? turnTimerSeconds : 60
}
