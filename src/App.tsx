import { useEffect, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import {
  GANJI_LIMIT,
  GAME_OVER_SCORE_OPTIONS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  calculateHandValue,
  canDrawFromDeck,
  cardLabel,
  cardName,
  cardsShareValue,
  formatCount,
  isRedSuit,
  type Card,
  type GameState,
  type Player,
} from './game'
import {
  checkSavedOnlineSession,
  forgetOnlineSession as forgetStoredOnlineSession,
  getReconnectDelayMs,
  isInvalidReconnectMessage,
  loadOnlinePlayerName,
  loadSavedOnlineSession,
  resolveReconnectCheckUrl,
  resolveWebSocketUrl,
  saveOnlinePlayerName,
  saveOnlineSession,
  type OnlineConnectionStatus,
  type SavedOnlineSession,
} from './onlineConnection'
import type {
  ClientToServerMessage,
  OnlineRoomView,
  ServerToClientMessage,
} from './online'

const GANJI_SUCCESS_AUDIO = '/audio/Ganji_Success.mp3'
const GANJI_FAIL_AUDIO = '/audio/Ganji_Fail.mp3'
const DISCARD_AUDIO_BY_COUNT = {
  1: '/audio/1_Discard.mp3',
  2: '/audio/2_Discard.mp3',
  3: '/audio/3_Discard.mp3',
  4: '/audio/4_Discard.mp3',
} as const
const DISCARD_AUDIO_VOLUME_BY_COUNT = {
  1: 0.35,
  2: 0.55,
  3: 0.75,
  4: 1,
} as const
const TURN_TIMER_OPTIONS = [
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '1.5 minutes', seconds: 90 },
  { label: '2 minutes', seconds: 120 },
]
const CARD_ASSET_RANKS = [
  'ace',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
] as const
const CARD_ASSET_SUITS = ['spades', 'hearts', 'diamonds', 'clubs'] as const
const STANDARD_FACE_ASSET_RANKS = ['jack', 'queen', 'king'] as const
const APP_ASSET_URLS = [
  '/images/table.png',
  GANJI_SUCCESS_AUDIO,
  GANJI_FAIL_AUDIO,
  ...Object.values(DISCARD_AUDIO_BY_COUNT),
  ...CARD_ASSET_RANKS.flatMap((rank) =>
    CARD_ASSET_SUITS.map((suit) => `/cards/${rank}_of_${suit}.png`),
  ),
  ...STANDARD_FACE_ASSET_RANKS.flatMap((rank) =>
    CARD_ASSET_SUITS.map((suit) => `/cards/${rank}_of_${suit}2.png`),
  ),
]

type CardArtworkStyle = 'standard'

type SelectionState = {
  turnKey: string
  cardIds: string[]
}

function App() {
  const assetPreload = useAssetPreload(APP_ASSET_URLS)

  if (!assetPreload.ready) {
    return <LoadingScreen loaded={assetPreload.loaded} total={assetPreload.total} />
  }

  return <GanjiApp />
}

function GanjiApp() {
  const cardArtworkStyle: CardArtworkStyle = 'standard'

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Internet multiplayer card game</p>
          <h1>Ganji</h1>
          <p className="lede">
            Discard matching values, draw one card, and call Ganji when your hand
            is 5 or less.
          </p>
        </div>
      </header>

      <OnlineMultiplayer cardArtworkStyle={cardArtworkStyle} />
    </main>
  )
}

type LoadingScreenProps = {
  loaded: number
  total: number
}

function LoadingScreen({ loaded, total }: LoadingScreenProps) {
  const progress = total > 0 ? Math.round((loaded / total) * 100) : 100

  return (
    <main className="loading-screen">
      <div className="loading-card">
        <p className="eyebrow">Preparing table</p>
        <h1>Ganji</h1>
        <p>Loading cards, table art, and sounds before play starts.</p>
        <div className="loading-meter" aria-label="Asset loading progress">
          <span style={{ width: `${progress}%` }}></span>
        </div>
        <strong>
          {loaded} / {total} assets loaded
        </strong>
      </div>
    </main>
  )
}

function useAssetPreload(assetUrls: string[]) {
  const [loaded, setLoaded] = useState(0)

  useEffect(() => {
    let cancelled = false
    let loadedCount = 0

    for (const assetUrl of assetUrls) {
      preloadAsset(assetUrl).finally(() => {
        if (cancelled) {
          return
        }

        loadedCount += 1
        setLoaded(loadedCount)
      })
    }

    return () => {
      cancelled = true
    }
  }, [assetUrls])

  return {
    loaded,
    total: assetUrls.length,
    ready: loaded >= assetUrls.length,
  }
}

function preloadAsset(assetUrl: string): Promise<void> {
  if (assetUrl.endsWith('.mp3')) {
    return preloadAudio(assetUrl)
  }

  return new Promise((resolve) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(), { once: true })
    image.addEventListener('error', () => resolve(), { once: true })
    image.src = assetUrl
  })
}

function preloadAudio(assetUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio()
    let resolved = false
    const timeout = window.setTimeout(finish, 5000)

    function finish() {
      if (resolved) {
        return
      }

      resolved = true
      window.clearTimeout(timeout)
      audio.removeEventListener('canplaythrough', finish)
      audio.removeEventListener('error', finish)
      resolve()
    }

    audio.preload = 'auto'
    audio.addEventListener('canplaythrough', finish)
    audio.addEventListener('error', finish)
    audio.src = assetUrl
    audio.load()
  })
}

type OnlineMultiplayerProps = {
  cardArtworkStyle: CardArtworkStyle
}

function OnlineMultiplayer({ cardArtworkStyle }: OnlineMultiplayerProps) {
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const intentionalCloseRef = useRef(false)
  const roomRef = useRef<OnlineRoomView | null>(null)
  const savedSessionRef = useRef<SavedOnlineSession | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<OnlineConnectionStatus>('idle')
  const [playerName, setPlayerName] = useState(() => loadOnlinePlayerName(localStorage))
  const [turnTimerSeconds, setTurnTimerSeconds] = useState(60)
  const [gameOverScore, setGameOverScore] = useState(100)
  const [joinRoomCode, setJoinRoomCode] = useState('')
  const [room, setRoom] = useState<OnlineRoomView | null>(null)
  const [storedSessionToCheck] = useState(() => loadSavedOnlineSession(localStorage))
  const [serverMessage, setServerMessage] = useState(() =>
    storedSessionToCheck
      ? `Checking saved room ${storedSessionToCheck.roomCode}...`
      : 'Create an online room or join one with a code.',
  )
  const [savedSession, setSavedSession] = useState<SavedOnlineSession | null>(null)
  const [checkingSavedSession, setCheckingSavedSession] = useState(() =>
    Boolean(storedSessionToCheck),
  )
  const [selection, setSelection] = useState<SelectionState>({
    turnKey: '',
    cardIds: [],
  })

  const gameState = room?.gameState ?? null
  const currentPlayer = gameState?.players[gameState.currentPlayerIndex]
  const isViewerTurn = Boolean(
    room && currentPlayer && currentPlayer.id === room.viewerPlayerId,
  )
  const turnKey = `online:${room?.roomCode ?? 'none'}:${gameState?.roundNumber ?? 0}:${
    currentPlayer?.id ?? 'none'
  }`
  const selectedCardIds = selection.turnKey === turnKey ? selection.cardIds : []
  const selectedCards =
    currentPlayer && isViewerTurn
      ? currentPlayer.hand.filter((card) => selectedCardIds.includes(card.id))
      : []
  const selectedCardsAreValid =
    selectedCards.length > 0 &&
    selectedCards.length === selectedCardIds.length &&
    cardsShareValue(selectedCards)
  const actionsDisabled = connectionStatus !== 'connected'

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    savedSessionRef.current = savedSession
  }, [savedSession])

  useEffect(() => {
    saveOnlinePlayerName(localStorage, playerName)
  }, [playerName])

  useEffect(() => {
    if (!storedSessionToCheck) {
      return
    }

    let cancelled = false

    checkSavedOnlineSession(fetch, getReconnectCheckUrl(), storedSessionToCheck).then((result) => {
      if (cancelled || roomRef.current || socketRef.current) {
        return
      }

      setCheckingSavedSession(false)

      if (result === 'valid') {
        savedSessionRef.current = storedSessionToCheck
        setSavedSession(storedSessionToCheck)
        setServerMessage(`Saved room ${storedSessionToCheck.roomCode} is available.`)
        return
      }

      if (result === 'invalid') {
        forgetStoredOnlineSession(localStorage)
        savedSessionRef.current = null
        setSavedSession(null)
        setServerMessage('Your saved room is no longer available. Create or join a room.')
        return
      }

      setSavedSession(null)
      setServerMessage('Could not verify your saved room. Create or join a room to play.')
    })

    return () => {
      cancelled = true
    }
  }, [storedSessionToCheck])

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      intentionalCloseRef.current = true
      socketRef.current?.close()
    }
  }, [])

  function clearReconnectTimer() {
    if (reconnectTimerRef.current === null) {
      return
    }

    window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
  }

  function connectWithMessage(
    message: ClientToServerMessage,
    status: Extract<OnlineConnectionStatus, 'connecting' | 'reconnecting'> = 'connecting',
    resetReconnectAttempts = true,
  ) {
    clearReconnectTimer()
    if (resetReconnectAttempts) {
      reconnectAttemptRef.current = 0
    }

    intentionalCloseRef.current = false
    socketRef.current?.close()
    setConnectionStatus(status)
    setServerMessage(
      status === 'reconnecting'
        ? 'Connection lost. Reconnecting to Ganji server...'
        : 'Connecting to Ganji server...',
    )

    const socket = new WebSocket(getWebSocketUrl())
    socketRef.current = socket

    socket.addEventListener('open', () => {
      if (socketRef.current !== socket) {
        return
      }

      setConnectionStatus('connected')
      reconnectAttemptRef.current = 0
      socket.send(JSON.stringify(message))
    })

    socket.addEventListener('message', (event) => {
      if (socketRef.current !== socket) {
        return
      }

      if (typeof event.data !== 'string') {
        return
      }

      handleOnlineServerMessage(event.data)
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) {
        return
      }

      socketRef.current = null

      if (intentionalCloseRef.current) {
        return
      }

      if (roomRef.current && savedSessionRef.current) {
        scheduleAutoReconnect()
        return
      }

      setConnectionStatus('disconnected')
      setServerMessage('Disconnected from the Ganji server.')
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket) {
        return
      }

      setServerMessage('Could not connect to the Ganji server.')
    })
  }

  function scheduleAutoReconnect() {
    const reconnectSession = savedSessionRef.current
    if (!reconnectSession) {
      setConnectionStatus('disconnected')
      setServerMessage('Disconnected from the Ganji server.')
      return
    }

    const delay = getReconnectDelayMs(reconnectAttemptRef.current)
    reconnectAttemptRef.current += 1
    setConnectionStatus('reconnecting')
    setServerMessage(`Connection lost. Reconnecting in ${Math.ceil(delay / 1000)}s...`)
    clearReconnectTimer()
    reconnectTimerRef.current = window.setTimeout(() => {
      connectWithMessage(
        {
          type: 'REJOIN_ROOM',
          roomCode: reconnectSession.roomCode,
          sessionId: reconnectSession.sessionId,
        },
        'reconnecting',
        false,
      )
    }, delay)
  }

  function handleOnlineServerMessage(rawMessage: string) {
    let message: ServerToClientMessage

    try {
      message = JSON.parse(rawMessage) as ServerToClientMessage
    } catch {
      setServerMessage('Received an invalid server message.')
      return
    }

    if (message.type === 'ERROR') {
      if (isInvalidReconnectMessage(message.message)) {
        clearReconnectTimer()
        roomRef.current = null
        savedSessionRef.current = null
        setRoom(null)
        setSelection({ turnKey: '', cardIds: [] })
        setConnectionStatus('disconnected')
        forgetOnlineSession()
      }

      setServerMessage(message.message)
      return
    }

    if (message.type === 'ROOM_CLOSED') {
      clearReconnectTimer()
      roomRef.current = null
      savedSessionRef.current = null
      setRoom(null)
      setSelection({ turnKey: '', cardIds: [] })
      setConnectionStatus('disconnected')
      setServerMessage(message.message)
      forgetOnlineSession()
      return
    }

    clearReconnectTimer()
    reconnectAttemptRef.current = 0
    setConnectionStatus('connected')
    roomRef.current = message.room
    setRoom(message.room)
    setServerMessage(message.room.message)

    const session = {
      roomCode: message.room.roomCode,
      sessionId: message.sessionId,
    }
    savedSessionRef.current = session
    setSavedSession(session)
    saveOnlineSession(localStorage, session)
  }

  function sendOnlineMessage(message: ClientToServerMessage) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setServerMessage('Not connected. Reconnect to continue playing.')
      return
    }

    socketRef.current.send(JSON.stringify(message))
  }

  function createOnlineRoom() {
    clearReconnectTimer()
    connectWithMessage({
      type: 'CREATE_ROOM',
      name: playerName,
      turnTimerSeconds,
      gameOverScore,
    })
  }

  function leaveOnlineRoom() {
    clearReconnectTimer()
    intentionalCloseRef.current = true
    const socket = socketRef.current
    socketRef.current = null
    socket?.close()
    roomRef.current = null
    setRoom(null)
    setSelection({ turnKey: '', cardIds: [] })
    setConnectionStatus('idle')
    setServerMessage('Left the room. Create or join another room.')
  }

  function deleteOnlineRoom() {
    sendOnlineMessage({ type: 'DELETE_ROOM' })
  }

  function joinOnlineRoom() {
    clearReconnectTimer()
    connectWithMessage({
      type: 'JOIN_ROOM',
      roomCode: joinRoomCode,
      name: playerName,
    })
  }

  function reconnectOnlineRoom() {
    if (!savedSession) {
      return
    }

    clearReconnectTimer()
    connectWithMessage({
      type: 'REJOIN_ROOM',
      roomCode: savedSession.roomCode,
      sessionId: savedSession.sessionId,
    })
  }

  function forgetOnlineSession() {
    clearReconnectTimer()
    forgetStoredOnlineSession(localStorage)
    savedSessionRef.current = null
    setSavedSession(null)
  }

  function toggleOnlineCard(card: Card) {
    if (actionsDisabled || !gameState || gameState.phase !== 'discard' || !isViewerTurn) {
      return
    }

    setSelection((currentSelection) => {
      const cardIds =
        currentSelection.turnKey === turnKey ? currentSelection.cardIds : []

      return {
        turnKey,
        cardIds: cardIds.includes(card.id)
          ? cardIds.filter((cardId) => cardId !== card.id)
          : [...cardIds, card.id],
      }
    })
  }

  function discardOnlineCards() {
    if (actionsDisabled || !selectedCardsAreValid) {
      return
    }

    sendOnlineMessage({ type: 'DISCARD_CARDS', cardIds: selectedCardIds })
    setSelection({ turnKey, cardIds: [] })
  }

  if (room?.gameState) {
    return (
      <>
        <OnlineRoomBar
          room={room}
          connectionStatus={connectionStatus}
          connectionMessage={serverMessage}
          actionsDisabled={actionsDisabled}
          onCreateRoom={createOnlineRoom}
          onDeleteRoom={deleteOnlineRoom}
          onLeaveRoom={leaveOnlineRoom}
          onReconnect={reconnectOnlineRoom}
        />
        <GameScreen
          state={room.gameState}
          currentPlayer={currentPlayer}
          cardArtworkStyle={cardArtworkStyle}
          actionsDisabled={actionsDisabled}
          viewerPlayerId={room.viewerPlayerId}
          handVisible
          selectedCardIds={selectedCardIds}
          selectedCardsAreValid={selectedCardsAreValid}
          onShowHand={() => undefined}
          onToggleCard={toggleOnlineCard}
          onDiscard={discardOnlineCards}
          onDrawDeck={() => sendOnlineMessage({ type: 'DRAW_CARD', source: 'deck' })}
          onDrawDiscard={() =>
            sendOnlineMessage({ type: 'DRAW_CARD', source: 'discard' })
          }
          onCallGanji={() => sendOnlineMessage({ type: 'CALL_GANJI' })}
          onNextRound={() => sendOnlineMessage({ type: 'START_NEXT_ROUND' })}
          onReset={() => setRoom(null)}
        />
      </>
    )
  }

  return (
    <section className="setup-grid online-setup-grid">
      <div className="panel setup-panel online-panel">
        <div className="section-heading">
          <p className="eyebrow">Online multiplayer</p>
          <h2>Create or join a room</h2>
        </div>

        <p className="message-bar online-message">{serverMessage}</p>

        <label className="field-label" htmlFor="online-name">
          Your name
        </label>
        <input
          id="online-name"
          type="text"
          value={playerName}
          onChange={(event) => setPlayerName(event.target.value)}
        />

        <label className="field-label" htmlFor="turn-timer">
          Turn timer
        </label>
        <select
          id="turn-timer"
          value={turnTimerSeconds}
          onChange={(event) => setTurnTimerSeconds(Number(event.target.value))}
        >
          {TURN_TIMER_OPTIONS.map((option) => (
            <option key={option.seconds} value={option.seconds}>
              {option.label}
            </option>
          ))}
        </select>

        <label className="field-label" htmlFor="game-over-score">
          End game limit
        </label>
        <select
          id="game-over-score"
          value={gameOverScore}
          onChange={(event) => setGameOverScore(Number(event.target.value))}
        >
          {GAME_OVER_SCORE_OPTIONS.map((score) => (
            <option key={score} value={score}>
              {score} points
            </option>
          ))}
        </select>

        <div className="online-actions-grid">
          <button
            className="primary-button"
            type="button"
            disabled={connectionStatus === 'connecting' || connectionStatus === 'reconnecting'}
            onClick={createOnlineRoom}
          >
            Create room
          </button>
          <div className="join-room-controls">
            <label className="field-label" htmlFor="room-code">
              Room code
            </label>
            <input
              id="room-code"
              type="text"
              value={joinRoomCode}
              onChange={(event) => setJoinRoomCode(event.target.value.toUpperCase())}
              placeholder="ABC123"
            />
            <button
              className="secondary-button"
              type="button"
              disabled={connectionStatus === 'connecting' || connectionStatus === 'reconnecting'}
              onClick={joinOnlineRoom}
            >
              Join room
            </button>
          </div>
        </div>

        {checkingSavedSession && (
          <div className="reconnect-card">
            <div>
              <strong>Checking saved room</strong>
              <span>Verifying that your previous room still exists.</span>
            </div>
          </div>
        )}

        {!checkingSavedSession && savedSession && (
          <div className="reconnect-card">
            <div>
              <strong>Saved room {savedSession.roomCode}</strong>
              <span>Reconnect if you refreshed or disconnected.</span>
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
                disabled={connectionStatus === 'connecting' || connectionStatus === 'reconnecting'}
                onClick={reconnectOnlineRoom}
              >
                Reconnect
              </button>
              <button className="ghost-button" type="button" onClick={forgetOnlineSession}>
                Forget
              </button>
            </div>
          </div>
        )}

        {room && (
          <OnlineLobby
            room={room}
            connectionStatus={connectionStatus}
            actionsDisabled={actionsDisabled}
            onAddBot={() => sendOnlineMessage({ type: 'ADD_BOT' })}
            onRemoveBot={(playerId) =>
              sendOnlineMessage({ type: 'REMOVE_BOT', playerId })
            }
            onKickPlayer={(playerId) =>
              sendOnlineMessage({ type: 'KICK_PLAYER', playerId })
            }
            onSetReady={(ready) => sendOnlineMessage({ type: 'SET_READY', ready })}
            onStartGame={() => sendOnlineMessage({ type: 'START_GAME' })}
            onDeleteRoom={deleteOnlineRoom}
            onLeaveRoom={leaveOnlineRoom}
            onReconnect={reconnectOnlineRoom}
          />
        )}
      </div>

      <OnlineRulesPanel />
    </section>
  )
}

type OnlineRoomBarProps = {
  room: OnlineRoomView
  connectionStatus: OnlineConnectionStatus
  connectionMessage: string
  actionsDisabled: boolean
  onCreateRoom: () => void
  onDeleteRoom: () => void
  onLeaveRoom: () => void
  onReconnect: () => void
}

function OnlineRoomBar({
  room,
  connectionStatus,
  connectionMessage,
  actionsDisabled,
  onCreateRoom,
  onDeleteRoom,
  onLeaveRoom,
  onReconnect,
}: OnlineRoomBarProps) {
  const remainingSeconds = useTurnTimerRemaining(room.turnDeadline)
  const isHost = room.viewerPlayerId === room.hostPlayerId
  const substituteCount = room.players.filter((player) => player.substituteActive).length

  return (
    <section className="online-room-bar panel">
      <div>
        <p className="eyebrow">Online room</p>
        <h2>{room.roomCode}</h2>
      </div>
      <div className="online-room-meta">
        <span>{connectionStatus}</span>
        {connectionStatus !== 'connected' && <span>{connectionMessage}</span>}
        <span>{room.players.length} players</span>
        <span>Timer: {formatTimerSeconds(room.turnTimerSeconds)}</span>
        <span>Limit: {room.gameOverScore}</span>
        {substituteCount > 0 && (
          <span>{formatCount(substituteCount, 'BOT substitute')}</span>
        )}
        {remainingSeconds !== null && <span>Turn: {remainingSeconds}s</span>}
        <button className="secondary-button" type="button" onClick={onCreateRoom}>
          New room
        </button>
        <button className="ghost-button" type="button" onClick={onLeaveRoom}>
          Leave room
        </button>
        {isHost && (
          <button
            className="ghost-button danger-button"
            type="button"
            disabled={actionsDisabled}
            onClick={onDeleteRoom}
          >
            Delete room
          </button>
        )}
        <button className="ghost-button" type="button" onClick={onReconnect}>
          Reconnect
        </button>
      </div>
    </section>
  )
}

function useTurnTimerRemaining(turnDeadline: number | null): number | null {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!turnDeadline) {
      return
    }

    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 500)

    return () => window.clearInterval(interval)
  }, [turnDeadline])

  return getRemainingSeconds(turnDeadline, now)
}

function getRemainingSeconds(turnDeadline: number | null, now = Date.now()): number | null {
  if (!turnDeadline) {
    return null
  }

  return Math.max(0, Math.ceil((turnDeadline - now) / 1000))
}

type OnlineLobbyProps = {
  room: OnlineRoomView
  connectionStatus: OnlineConnectionStatus
  actionsDisabled: boolean
  onAddBot: () => void
  onRemoveBot: (playerId: string) => void
  onKickPlayer: (playerId: string) => void
  onSetReady: (ready: boolean) => void
  onStartGame: () => void
  onDeleteRoom: () => void
  onLeaveRoom: () => void
  onReconnect: () => void
}

function OnlineLobby({
  room,
  connectionStatus,
  actionsDisabled,
  onAddBot,
  onRemoveBot,
  onKickPlayer,
  onSetReady,
  onStartGame,
  onDeleteRoom,
  onLeaveRoom,
  onReconnect,
}: OnlineLobbyProps) {
  const isHost = room.viewerPlayerId === room.hostPlayerId
  const viewer = room.players.find((player) => player.id === room.viewerPlayerId)
  const canStart =
    room.players.length >= MIN_PLAYERS &&
    room.players.every((player) => player.ready && (player.isBot || player.connected))

  return (
    <div className="online-lobby">
      <div className="room-code-card">
        <span>Room code</span>
        <strong>{room.roomCode}</strong>
        <p>Share this code with friends after deploying or running the server.</p>
      </div>

      <div className="online-room-meta">
        <span>Status: {connectionStatus}</span>
        <span>Timer: {formatTimerSeconds(room.turnTimerSeconds)}</span>
        <span>Limit: {room.gameOverScore}</span>
        <span>{isHost ? 'You are host' : 'Waiting for host'}</span>
      </div>

      <div className="lobby-player-list">
        {room.players.map((player) => (
          <div className="lobby-player-row" key={player.id}>
            <div>
              <strong>{player.name}</strong>
              <span>{formatOnlinePlayerStatus(player)}</span>
            </div>
            {isHost && player.id !== room.hostPlayerId && (
              <div className="button-row compact-buttons">
                {player.isBot ? (
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => onRemoveBot(player.id)}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => onKickPlayer(player.id)}
                  >
                    Kick
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {!isHost && viewer && (
        <button
          className={viewer.ready ? 'secondary-button' : 'primary-button'}
          type="button"
          disabled={actionsDisabled}
          onClick={() => onSetReady(!viewer.ready)}
        >
          {viewer.ready ? 'Cancel ready' : 'Ready'}
        </button>
      )}

      {isHost ? (
        <div className="button-row">
          <button
            className="secondary-button"
            type="button"
            disabled={actionsDisabled || room.players.length >= MAX_PLAYERS}
            onClick={onAddBot}
          >
            Add BOT
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={actionsDisabled || !canStart}
            onClick={onStartGame}
          >
            Start game
          </button>
          <button
            className="ghost-button danger-button"
            type="button"
            disabled={actionsDisabled}
            onClick={onDeleteRoom}
          >
            Delete room
          </button>
        </div>
      ) : (
        <div className="lobby-secondary-actions">
          <p className="phase-banner">The host will start when the table is ready.</p>
          <button className="ghost-button" type="button" onClick={onLeaveRoom}>
            Leave room
          </button>
        </div>
      )}

      {isHost && (
        <button className="ghost-button" type="button" onClick={onLeaveRoom}>
          Leave without deleting
        </button>
      )}

      {connectionStatus === 'disconnected' && (
        <button className="primary-button" type="button" onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </div>
  )
}

function formatOnlinePlayerStatus(player: OnlineRoomView['players'][number]): string {
  if (player.isBot) {
    return 'BOT - ready'
  }

  if (player.substituteActive) {
    return 'Disconnected - BOT playing this seat'
  }

  return `${player.connected ? 'Connected' : 'Disconnected'} - ${
    player.ready ? 'ready' : 'not ready'
  }`
}

function OnlineRulesPanel() {
  return (
    <aside className="panel rules-panel">
      <div className="section-heading">
        <p className="eyebrow">Internet play</p>
        <h2>What is online now</h2>
      </div>
      <ul>
        <li>The server owns the deck, hands, turns, and scores.</li>
        <li>Each player only receives their own hand while a round is active.</li>
        <li>Friends join with a room code.</li>
        <li>The host chooses the turn timer and point limit, adds BOTs, kicks humans, and can delete the room.</li>
        <li>Humans must mark ready before the host can start the game.</li>
        <li>Disconnected players time out once, then a BOT plays their seat until they rejoin.</li>
        <li>Inactive rooms are removed after 15 minutes without connected humans.</li>
      </ul>
    </aside>
  )
}

type GameScreenProps = {
  state: GameState
  currentPlayer: Player | undefined
  cardArtworkStyle: CardArtworkStyle
  actionsDisabled: boolean
  viewerPlayerId?: string
  handVisible: boolean
  selectedCardIds: string[]
  selectedCardsAreValid: boolean
  onShowHand: () => void
  onToggleCard: (card: Card) => void
  onDiscard: () => void
  onDrawDeck: () => void
  onDrawDiscard: () => void
  onCallGanji: () => void
  onNextRound: () => void
  onReset: () => void
}

function GameScreen({
  state,
  currentPlayer,
  cardArtworkStyle,
  actionsDisabled,
  viewerPlayerId,
  handVisible,
  selectedCardIds,
  selectedCardsAreValid,
  onShowHand,
  onToggleCard,
  onDiscard,
  onDrawDeck,
  onDrawDiscard,
  onCallGanji,
  onNextRound,
  onReset,
}: GameScreenProps) {
  useGanjiResultAudio(state)
  useDiscardAudio(state)

  const revealedPlayerId = viewerPlayerId
    ? viewerPlayerId
    : handVisible && currentPlayer && !currentPlayer.isBot
      ? currentPlayer.id
      : null
  const perspectivePlayerId = viewerPlayerId ?? currentPlayer?.id ?? null

  return (
    <div className={`game-layout${state.status === 'playing' ? ' active-game-layout' : ''}`}>
      <Scoreboard state={state} />

      <section className="table-panel">
        <div className="table-status">
          <div>
            <p className="eyebrow">Round {state.roundNumber}</p>
            <h2>{state.status === 'playing' ? 'Table' : 'Round result'}</h2>
          </div>
          <div className="deck-stats">
            <span>{state.deck.length} in deck</span>
            <span>{state.discardPile.length} buried</span>
          </div>
        </div>

        <p className="message-bar">{state.message}</p>

        {state.status === 'playing' && currentPlayer && (
          <>
            <TableSurface
              state={state}
              currentPlayerId={currentPlayer.id}
              perspectivePlayerId={perspectivePlayerId}
              revealedPlayerId={revealedPlayerId}
              cardArtworkStyle={cardArtworkStyle}
              selectedCardIds={selectedCardIds}
              onToggleCard={onToggleCard}
              onDrawDeck={onDrawDeck}
              onDrawDiscard={onDrawDiscard}
              canUseTableDraws={
                !actionsDisabled &&
                (!viewerPlayerId || viewerPlayerId === currentPlayer.id) &&
                !currentPlayer.isBot
              }
            />
            <TableActionArea
              state={state}
              player={currentPlayer}
              viewerPlayerId={viewerPlayerId}
              handVisible={handVisible}
              actionsDisabled={actionsDisabled}
              selectedCardIds={selectedCardIds}
              selectedCardsAreValid={selectedCardsAreValid}
              onShowHand={onShowHand}
              onDiscard={onDiscard}
              onCallGanji={onCallGanji}
            />
          </>
        )}

        {state.status === 'roundOver' && (
          <RoundResult
            state={state}
            cardArtworkStyle={cardArtworkStyle}
            actionsDisabled={actionsDisabled}
            onNextRound={onNextRound}
          />
        )}

        {state.status === 'gameOver' && (
          <GameOver
            state={state}
            cardArtworkStyle={cardArtworkStyle}
            onReset={onReset}
          />
        )}
      </section>
    </div>
  )
}

function useGanjiResultAudio(state: GameState) {
  const playedResultKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (state.status !== 'roundOver' && state.status !== 'gameOver') {
      return
    }

    const summary = state.roundSummary
    if (!summary) {
      return
    }

    const resultKey = `${summary.roundNumber}:${summary.callerId}:${summary.callerHadLowest}`
    if (playedResultKeyRef.current === resultKey) {
      return
    }

    playedResultKeyRef.current = resultKey
    const audio = new Audio(summary.callerHadLowest ? GANJI_SUCCESS_AUDIO : GANJI_FAIL_AUDIO)

    audio.play().catch(() => {
      // Browsers can block audio until the user interacts with the page.
    })
  }, [state.roundSummary, state.status])
}

function useDiscardAudio(state: GameState) {
  const playedDiscardKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (state.status !== 'playing' || !state.pendingNextOffer) {
      return
    }

    const discard = state.pendingNextOffer
    const discardKey = `${state.roundNumber}:${discard.fromPlayerId}:${discard.card.id}:${discard.discardedCount}`
    if (playedDiscardKeyRef.current === discardKey) {
      return
    }

    playedDiscardKeyRef.current = discardKey
    playDiscardAudio(discard.discardedCount)
  }, [state.pendingNextOffer, state.roundNumber, state.status])
}

function playDiscardAudio(discardedCount: number) {
  const normalizedCount = Math.min(4, Math.max(1, discardedCount)) as keyof typeof DISCARD_AUDIO_BY_COUNT
  const audioPath = DISCARD_AUDIO_BY_COUNT[normalizedCount]
  const audio = new Audio(audioPath)
  audio.volume = DISCARD_AUDIO_VOLUME_BY_COUNT[normalizedCount]

  audio.play().catch(() => {
    // Browsers can block audio until the user interacts with the page.
  })

  if (discardedCount === 3) {
    window.setTimeout(() => {
      audio.pause()
      audio.currentTime = 0
    }, 2000)
  }
}

type TableSurfaceProps = {
  state: GameState
  currentPlayerId: string
  perspectivePlayerId: string | null
  revealedPlayerId: string | null
  cardArtworkStyle: CardArtworkStyle
  selectedCardIds: string[]
  onToggleCard: (card: Card) => void
  onDrawDeck: () => void
  onDrawDiscard: () => void
  canUseTableDraws: boolean
}

function TableSurface({
  state,
  currentPlayerId,
  perspectivePlayerId,
  revealedPlayerId,
  cardArtworkStyle,
  selectedCardIds,
  onToggleCard,
  onDrawDeck,
  onDrawDiscard,
  canUseTableDraws,
}: TableSurfaceProps) {
  const deckAvailable = canDrawFromDeck(state)
  const latestDiscard = state.drawOffer
  const justDiscarded = state.pendingNextOffer

  return (
    <section className="felt-table" aria-label="Playing table">
      <PlayerHandsOnTable
        players={state.players}
        currentPlayerId={currentPlayerId}
        perspectivePlayerId={perspectivePlayerId}
        revealedPlayerId={revealedPlayerId}
        cardArtworkStyle={cardArtworkStyle}
        selectedCardIds={selectedCardIds}
        selectablePlayerId={currentPlayerId}
        phase={state.phase}
        onToggleCard={onToggleCard}
      />
      <div className="felt-table-inner">
        <button
          className="table-zone deck-zone"
          type="button"
          disabled={!canUseTableDraws || state.phase !== 'draw' || !deckAvailable}
          onClick={onDrawDeck}
        >
          <span className="slot-label">Main deck</span>
          <DeckStack />
          <span className="slot-meta">
            {deckAvailable
              ? state.deck.length > 0
                ? `${state.deck.length} cards`
                : `${state.discardPile.length} buried cards reshuffle`
              : 'Empty'}
          </span>
        </button>

        <button
          className="table-zone discard-zone"
          type="button"
          disabled={!canUseTableDraws || state.phase !== 'draw' || !latestDiscard}
          onClick={onDrawDiscard}
        >
          <span className="slot-label">Latest discard</span>
          {latestDiscard ? (
            <CardFace
              card={latestDiscard.card}
              cardArtworkStyle={cardArtworkStyle}
              table
            />
          ) : (
            <EmptyCardSlot label="No discard" />
          )}
          <span className="slot-meta">
            {latestDiscard
              ? `From ${latestDiscard.fromPlayerName}`
              : 'No discard'}
          </span>
        </button>

        <div className="table-zone just-discarded-zone" aria-live="polite">
          <span className="slot-label">Just discarded</span>
          {justDiscarded ? (
            <CardFace
              card={justDiscarded.card}
              cardArtworkStyle={cardArtworkStyle}
              table
            />
          ) : (
            <EmptyCardSlot label="Waiting" />
          )}
          <span className="slot-meta">
            {justDiscarded
              ? `From ${justDiscarded.fromPlayerName}`
              : 'Waiting'}
          </span>
        </div>
      </div>
    </section>
  )
}

type PlayerHandsOnTableProps = {
  players: Player[]
  currentPlayerId: string
  perspectivePlayerId: string | null
  revealedPlayerId: string | null
  cardArtworkStyle: CardArtworkStyle
  selectedCardIds: string[]
  selectablePlayerId: string
  phase: GameState['phase']
  onToggleCard: (card: Card) => void
}

function PlayerHandsOnTable({
  players,
  currentPlayerId,
  perspectivePlayerId,
  revealedPlayerId,
  cardArtworkStyle,
  selectedCardIds,
  selectablePlayerId,
  phase,
  onToggleCard,
}: PlayerHandsOnTableProps) {
  return (
    <div className="player-hands-table" aria-label="Players around the table">
      {players.map((player, index) => {
        const isCurrent = player.id === currentPlayerId
        const isRevealed = player.id === revealedPlayerId
        const isSelectable = isRevealed && player.id === selectablePlayerId
        const seatStyle = getPlayerSeatStyle(players, index, perspectivePlayerId)

        return (
          <section
            className={`table-player-hand${isCurrent ? ' current' : ''}${
              isRevealed ? ' revealed' : ''
            }`}
            key={player.id}
            style={seatStyle}
          >
            {isCurrent && <span className="turn-overlay">This player's turn</span>}
            <div className="table-player-label">
              <span className="player-avatar" aria-hidden="true">
                <span>{playerInitials(player.name)}</span>
              </span>
              <div>
                <strong>{player.name}</strong>
              </div>
            </div>
            <div className="mini-card-row">
              {player.hand.map((card) =>
                isSelectable ? (
                  <CardButton
                    card={card}
                    cardArtworkStyle={cardArtworkStyle}
                    disabled={phase !== 'discard'}
                    key={card.id}
                    selected={selectedCardIds.includes(card.id)}
                    onClick={() => onToggleCard(card)}
                  />
                ) : isRevealed ? (
                  <CardFace
                    card={card}
                    cardArtworkStyle={cardArtworkStyle}
                    compact
                    key={card.id}
                  />
                ) : (
                  <CardBack compact key={card.id} />
                ),
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

type SeatStyle = CSSProperties & {
  '--seat-x': string
  '--seat-y': string
}

function getPlayerSeatStyle(
  players: Player[],
  playerIndex: number,
  perspectivePlayerId: string | null,
): SeatStyle {
  const perspectiveIndex = Math.max(
    0,
    players.findIndex((player) => player.id === perspectivePlayerId),
  )
  const seatOffset =
    (playerIndex - perspectiveIndex + players.length) % players.length
  const angle = ((90 + (360 / players.length) * seatOffset) * Math.PI) / 180
  const x = 50 + 39 * Math.cos(angle)
  const y = 50 + 35 * Math.sin(angle)

  return {
    '--seat-x': `${x}%`,
    '--seat-y': `${y}%`,
  }
}

function playerInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return initials || 'P'
}

function DeckStack() {
  return (
    <span className="deck-stack" aria-hidden="true">
      <CardBack />
      <CardBack />
      <CardBack />
    </span>
  )
}

type CardBackProps = {
  compact?: boolean
}

function CardBack({ compact = false }: CardBackProps) {
  return (
    <span className={`card-back${compact ? ' compact' : ''}`}>
      <span className="card-back-grid"></span>
      <strong>G</strong>
    </span>
  )
}

type EmptyCardSlotProps = {
  label: string
}

function EmptyCardSlot({ label }: EmptyCardSlotProps) {
  return (
    <span className="empty-card-slot">
      <span>{label}</span>
    </span>
  )
}

type TableActionAreaProps = {
  state: GameState
  player: Player
  viewerPlayerId?: string
  handVisible: boolean
  actionsDisabled: boolean
  selectedCardIds: string[]
  selectedCardsAreValid: boolean
  onShowHand: () => void
  onDiscard: () => void
  onCallGanji: () => void
}

function TableActionArea({
  state,
  player,
  viewerPlayerId,
  handVisible,
  actionsDisabled,
  selectedCardIds,
  selectedCardsAreValid,
  onShowHand,
  onDiscard,
  onCallGanji,
}: TableActionAreaProps) {
  const isViewerTurn = !viewerPlayerId || player.id === viewerPlayerId

  if (!isViewerTurn) {
    return (
      <div className="table-action-area privacy-card">
        <p>
          Waiting while {player.name} discards, draws, or calls Ganji.
        </p>
      </div>
    )
  }

  const handValue = calculateHandValue(player.hand)
  const selectedCards = player.hand.filter((card) =>
    selectedCardIds.includes(card.id),
  )
  const canCallGanji = state.phase === 'discard' && handValue <= GANJI_LIMIT
  const humanHandHidden = !player.isBot && !handVisible

  if (player.isBot) {
    return (
      <div className="table-action-area bot-turn">
        <p>{player.name} is thinking. The BOT will act automatically.</p>
      </div>
    )
  }

  if (humanHandHidden) {
    return (
      <div className="table-action-area privacy-card">
        <button className="primary-button" type="button" onClick={onShowHand}>
          Unhide {player.name}'s cards
        </button>
        <p>
          Pass the laptop to {player.name}, then reveal the cards when other
          players are not looking.
        </p>
      </div>
    )
  }

  return (
    <div className="table-action-area">
      {state.phase === 'discard' && (
        <div className="action-panel">
          <div className="button-row">
            <button
              className="primary-button"
              type="button"
              disabled={actionsDisabled || !selectedCardsAreValid}
              onClick={onDiscard}
            >
              Discard selected
            </button>
            <GanjiButton
              canCall={canCallGanji}
              disabled={actionsDisabled}
              onCall={onCallGanji}
            />
          </div>
          <PhaseBanner phase={state.phase} />
          <p>
            Select one card, or several cards with the same value. Selected:{' '}
            {selectedCards.length === 0
              ? 'none'
              : selectedCards.map(cardLabel).join(', ')}
          </p>
          {selectedCards.length > 1 && !selectedCardsAreValid && (
            <p className="warning-text">Selected cards do not share one value.</p>
          )}
        </div>
      )}

      {state.phase === 'draw' && (
        <div className="action-panel">
          <PhaseBanner phase={state.phase} />
          <DrawChoices state={state} />
        </div>
      )}

      {state.phase === 'postDraw' && (
        <div className="action-panel">
          <PhaseBanner phase={state.phase} />
          <p>
            You drew one card. Your turn will pass automatically.
          </p>
        </div>
      )}
    </div>
  )
}

type DrawChoicesProps = {
  state: GameState
}

function DrawChoices({ state }: DrawChoicesProps) {
  const deckAvailable = canDrawFromDeck(state)

  return (
    <>
      <p>Draw one card from the table.</p>
      <div className="draw-reminder">
        <span>
          Main deck:{' '}
          {deckAvailable
            ? state.deck.length > 0
              ? `${state.deck.length} cards in deck`
              : `${state.discardPile.length} buried cards will reshuffle`
            : 'not available'}
        </span>
        <span>
          Latest discard:{' '}
          {state.drawOffer
            ? `${cardLabel(state.drawOffer.card)} from ${state.drawOffer.fromPlayerName}`
            : 'not available'}
        </span>
      </div>
    </>
  )
}

type GanjiButtonProps = {
  canCall: boolean
  disabled: boolean
  onCall: () => void
}

function GanjiButton({ canCall, disabled, onCall }: GanjiButtonProps) {
  return (
    <button
      className="ganji-button"
      type="button"
      disabled={disabled || !canCall}
      onClick={onCall}
    >
      {canCall ? 'Call GANJI' : 'GANJI unavailable'}
    </button>
  )
}

type PhaseBannerProps = {
  phase: GameState['phase']
}

function PhaseBanner({ phase }: PhaseBannerProps) {
  const text = {
    discard:
      'First action: call Ganji if your hand is 5 or less, or discard to continue.',
    draw: 'Draw one card from the deck or from the previous discard.',
    postDraw: 'Turn is ending automatically.',
  }[phase]

  return <p className="phase-banner">{text}</p>
}

type ScoreboardProps = {
  state: GameState
}

function Scoreboard({ state }: ScoreboardProps) {
  return (
    <aside className="scoreboard panel">
      <div className="section-heading">
        <p className="eyebrow">Race to avoid {state.gameOverScore}</p>
        <h2>Scores</h2>
      </div>
      <div className="score-list">
        {state.players.map((player, index) => {
          const isCurrent =
            state.status === 'playing' && index === state.currentPlayerIndex
          const isWinner = state.winnerIds.includes(player.id)

          return (
            <div
              className={`score-row${isCurrent ? ' current' : ''}${
                isWinner ? ' winner' : ''
              }`}
              key={player.id}
            >
              <div>
                <strong>{player.name}</strong>
                <span>{player.isBot ? 'BOT' : 'Human'}</span>
              </div>
              <div className="score-meta">
                <span>{formatCount(player.hand.length, 'card')}</span>
                <strong>{player.totalScore}</strong>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}

type RoundResultProps = {
  state: GameState
  cardArtworkStyle: CardArtworkStyle
  actionsDisabled: boolean
  onNextRound: () => void
}

function RoundResult({
  state,
  cardArtworkStyle,
  actionsDisabled,
  onNextRound,
}: RoundResultProps) {
  const summary = state.roundSummary

  if (!summary) {
    return null
  }

  return (
    <div className="result-card">
      <div className="result-heading">
        <div>
          <p className="eyebrow">Round {summary.roundNumber} complete</p>
          <h2>
            {summary.callerHadLowest ? 'Successful Ganji' : 'Ganji penalty'}
          </h2>
        </div>
        <p>
          {summary.callerName} called with {summary.callerHandValue}. Lowest hand
          was {summary.lowestHandValue}.
        </p>
      </div>

      <ScoreTable state={state} cardArtworkStyle={cardArtworkStyle} />

      <button
        className="primary-button"
        type="button"
        disabled={actionsDisabled}
        onClick={onNextRound}
      >
        Start next round
      </button>
    </div>
  )
}

type GameOverProps = {
  state: GameState
  cardArtworkStyle: CardArtworkStyle
  onReset: () => void
}

function GameOver({ state, cardArtworkStyle, onReset }: GameOverProps) {
  const standings = createFinalStandings(state)
  const winners = standings.filter((standing) => standing.rank === 1)

  return (
    <div className="result-card game-over-card">
      <div className="result-heading">
        <div>
          <p className="eyebrow">Game over</p>
          <h2>
            {winners.length > 1 ? 'Winners' : 'Winner'}:{' '}
            {winners.map((standing) => standing.playerName).join(', ')}
          </h2>
        </div>
        <p>
          Someone reached {state.gameOverScore}+ total points. Lowest total score wins.
        </p>
      </div>

      <FinalStandings standings={standings} cardArtworkStyle={cardArtworkStyle} />

      <button className="primary-button" type="button" onClick={onReset}>
        Play again
      </button>
    </div>
  )
}

type FinalStanding = {
  rank: number
  playerId: string
  playerName: string
  handValue: number
  roundPoints: number
  totalScore: number
  hand: Card[]
  isWinner: boolean
}

type FinalStandingsProps = {
  standings: FinalStanding[]
  cardArtworkStyle: CardArtworkStyle
}

function FinalStandings({ standings, cardArtworkStyle }: FinalStandingsProps) {
  return (
    <div className="final-standings" aria-label="Final player rankings">
      <div className="final-standings-header">
        <span>Rank</span>
        <span>Player</span>
        <span>Total</span>
        <span>Round</span>
        <span>Hand</span>
      </div>
      {standings.map((standing) => (
        <div
          className={`final-standing-row${standing.isWinner ? ' winner' : ''}`}
          key={standing.playerId}
        >
          <strong className="rank-pill">{formatRank(standing.rank)}</strong>
          <div className="final-player-summary">
            <strong>{standing.playerName}</strong>
            <span>{standing.isWinner ? 'Winner' : 'Final standing'}</span>
          </div>
          <span>{standing.totalScore}</span>
          <span>{standing.roundPoints}</span>
          <span>{standing.handValue}</span>
          <div className="revealed-hand final-hand">
            {standing.hand.map((card) => (
              <CardFace
                card={card}
                cardArtworkStyle={cardArtworkStyle}
                compact
                key={card.id}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function createFinalStandings(state: GameState): FinalStanding[] {
  const scores = state.players
    .map((player, playerIndex) => {
      const score = state.roundSummary?.scores.find(
        (roundScore) => roundScore.playerId === player.id,
      )

      return {
        playerIndex,
        playerId: player.id,
        playerName: score?.playerName ?? player.name,
        handValue: score?.handValue ?? calculateHandValue(player.hand),
        roundPoints: score?.roundPoints ?? 0,
        totalScore: score?.totalScore ?? player.totalScore,
        hand: player.hand,
      }
    })
    .sort(
      (firstPlayer, secondPlayer) =>
        firstPlayer.totalScore - secondPlayer.totalScore ||
        firstPlayer.playerIndex - secondPlayer.playerIndex,
    )

  let currentRank = 0
  let previousScore: number | null = null

  return scores.map((score, index) => {
    if (score.totalScore !== previousScore) {
      currentRank = index + 1
    }

    previousScore = score.totalScore

    return {
      ...score,
      rank: currentRank,
      isWinner: currentRank === 1,
    }
  })
}

function formatRank(rank: number): string {
  const lastTwoDigits = rank % 100

  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
    return `${rank}th`
  }

  const suffix =
    rank % 10 === 1 ? 'st' : rank % 10 === 2 ? 'nd' : rank % 10 === 3 ? 'rd' : 'th'

  return `${rank}${suffix}`
}

type ScoreTableProps = {
  state: GameState
  cardArtworkStyle: CardArtworkStyle
}

function ScoreTable({ state, cardArtworkStyle }: ScoreTableProps) {
  const scores = state.roundSummary?.scores ?? []

  return (
    <div className="score-table">
      <div className="score-table-header">
        <span>Player</span>
        <span>Hand</span>
        <span>Round</span>
        <span>Total</span>
      </div>
      {scores.map((score) => {
        const player = state.players.find((item) => item.id === score.playerId)

        return (
          <div className="score-table-row" key={score.playerId}>
            <span>
              {score.playerName}
              {score.isCaller ? ' (Ganji)' : ''}
              {score.penaltyApplied ? ' penalty' : ''}
            </span>
            <span>{score.handValue}</span>
            <span>{score.roundPoints}</span>
            <span>{score.totalScore}</span>
            {player && (
              <div className="revealed-hand">
                {player.hand.map((card) => (
                  <CardFace
                    card={card}
                    cardArtworkStyle={cardArtworkStyle}
                    compact
                    key={card.id}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

type CardButtonProps = {
  card: Card
  cardArtworkStyle: CardArtworkStyle
  selected: boolean
  disabled: boolean
  onClick: () => void
}

function CardButton({
  card,
  cardArtworkStyle,
  selected,
  disabled,
  onClick,
}: CardButtonProps) {
  return (
    <button
      className={`playing-card card-button${selected ? ' selected' : ''}${
        isRedSuit(card.suit) ? ' red' : ' black'
      }${card.value === 0 ? ' zero-card' : ''}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={cardName(card)}
    >
      <img
        alt={cardName(card)}
        className="card-image"
        draggable="false"
        src={cardImageSrc(card, cardArtworkStyle)}
      />
    </button>
  )
}

type CardFaceProps = {
  card: Card
  cardArtworkStyle: CardArtworkStyle
  compact?: boolean
  table?: boolean
}

function CardFace({
  card,
  cardArtworkStyle,
  compact = false,
  table = false,
}: CardFaceProps) {
  return (
    <span
      className={`playing-card static-card${compact ? ' compact' : ''}${
        table ? ' table-card' : ''
      }${isRedSuit(card.suit) ? ' red' : ' black'}${
        card.value === 0 ? ' zero-card' : ''
      }`}
      title={cardName(card)}
    >
      <img
        alt={cardName(card)}
        className="card-image"
        draggable="false"
        src={cardImageSrc(card, cardArtworkStyle)}
      />
    </span>
  )
}

function cardImageSrc(card: Card, artworkStyle: CardArtworkStyle): string {
  const rank = cardRankFileName(card.rank)
  const standardSuffix = artworkStyle === 'standard' && isFaceCard(card) ? '2' : ''

  return `/cards/${rank}_of_${card.suit}${standardSuffix}.png`
}

function cardRankFileName(rank: Card['rank']): string {
  const rankNames: Record<Card['rank'], string> = {
    A: 'ace',
    '2': '2',
    '3': '3',
    '4': '4',
    '5': '5',
    '6': '6',
    '7': '7',
    '8': '8',
    '9': '9',
    '10': '10',
    J: 'jack',
    Q: 'queen',
    K: 'king',
  }

  return rankNames[rank]
}

function isFaceCard(card: Card): boolean {
  return card.rank === 'J' || card.rank === 'Q' || card.rank === 'K'
}

function getWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined
  return resolveWebSocketUrl({
    configuredUrl,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    host: window.location.host,
    dev: import.meta.env.DEV,
  })
}

function getReconnectCheckUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined
  return resolveReconnectCheckUrl({
    configuredUrl,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    host: window.location.host,
    dev: import.meta.env.DEV,
  })
}

function formatTimerSeconds(seconds: number): string {
  const option = TURN_TIMER_OPTIONS.find((item) => item.seconds === seconds)
  return option?.label ?? `${seconds}s`
}

export default App
