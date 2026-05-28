import { useEffect, useReducer, useRef, useState, type CSSProperties } from 'react'
import './App.css'
import {
  GANJI_LIMIT,
  GAME_OVER_SCORE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  calculateHandValue,
  canDrawFromDeck,
  cardLabel,
  cardName,
  cardsShareValue,
  chooseBotDiscard,
  chooseBotDrawSource,
  formatCount,
  gameReducer,
  initialGameState,
  isRedSuit,
  type Card,
  type GameState,
  type Player,
  type SetupPlayerConfig,
} from './game'
import type {
  ClientToServerMessage,
  OnlineRoomView,
  ServerToClientMessage,
} from './online'

const STORAGE_KEY = 'ganji-game-state-v1'
const CARD_ARTWORK_STORAGE_KEY = 'ganji-card-artwork-style-v1'
const ONLINE_NAME_STORAGE_KEY = 'ganji-online-player-name-v1'
const ONLINE_SESSION_STORAGE_KEY = 'ganji-online-session-v1'
const GANJI_SUCCESS_AUDIO = '/audio/Ganji_Success.mp3'
const GANJI_FAIL_AUDIO = '/audio/Ganji_Fail.mp3'
const TURN_TIMER_OPTIONS = [
  { label: '30 seconds', seconds: 30 },
  { label: '1 minute', seconds: 60 },
  { label: '1.5 minutes', seconds: 90 },
  { label: '2 minutes', seconds: 120 },
]

type PlayMode = 'local' | 'online'
type CardArtworkStyle = 'standard' | 'simple'

type SelectionState = {
  turnKey: string
  cardIds: string[]
}

function App() {
  const [state, dispatch] = useReducer(gameReducer, undefined, loadSavedGame)
  const [playMode, setPlayMode] = useState<PlayMode>('local')
  const [playerCount, setPlayerCount] = useState(MIN_PLAYERS)
  const [playerDrafts, setPlayerDrafts] = useState<SetupPlayerConfig[]>(
    createDefaultPlayers,
  )
  const [selection, setSelection] = useState<SelectionState>({
    turnKey: '',
    cardIds: [],
  })
  const [visibleTurnKey, setVisibleTurnKey] = useState('')
  const [cardArtworkStyle, setCardArtworkStyle] =
    useState<CardArtworkStyle>(loadCardArtworkStyle)

  const currentPlayer = state.players[state.currentPlayerIndex]
  const turnKey = `${state.status}:${state.roundNumber}:${currentPlayer?.id ?? 'none'}`
  const selectedCardIds = selection.turnKey === turnKey ? selection.cardIds : []
  const handVisible = Boolean(currentPlayer?.isBot || visibleTurnKey === turnKey)
  const selectedCards = currentPlayer
    ? currentPlayer.hand.filter((card) => selectedCardIds.includes(card.id))
    : []
  const selectedCardsAreValid =
    selectedCards.length > 0 &&
    selectedCards.length === selectedCardIds.length &&
    cardsShareValue(selectedCards)

  useEffect(() => {
    try {
      if (state.status === 'setup') {
        localStorage.removeItem(STORAGE_KEY)
        return
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Local save is a convenience, so storage failures should not stop play.
    }
  }, [state])

  useEffect(() => {
    try {
      localStorage.setItem(CARD_ARTWORK_STORAGE_KEY, cardArtworkStyle)
    } catch {
      // Visual preference persistence should not block the game.
    }
  }, [cardArtworkStyle])

  useEffect(() => {
    if (playMode !== 'local' || state.status !== 'playing' || !currentPlayer?.isBot) {
      return
    }

    const timer = window.setTimeout(() => {
      const handValue = calculateHandValue(currentPlayer.hand)

      if (state.phase === 'discard' && handValue <= GANJI_LIMIT) {
        dispatch({ type: 'CALL_GANJI' })
        return
      }

      if (state.phase === 'discard') {
        const discardCards = chooseBotDiscard(currentPlayer.hand)
        dispatch({
          type: 'DISCARD_CARDS',
          cardIds: discardCards.map((card) => card.id),
        })
        return
      }

      if (state.phase === 'draw') {
        dispatch({ type: 'DRAW_CARD', source: chooseBotDrawSource(state) })
        return
      }

      dispatch({ type: 'END_TURN' })
    }, 700)

    return () => window.clearTimeout(timer)
  }, [currentPlayer, playMode, state])

  function updatePlayerDraft(
    playerIndex: number,
    patch: Partial<SetupPlayerConfig>,
  ) {
    setPlayerDrafts((players) =>
      players.map((player, index) =>
        index === playerIndex ? { ...player, ...patch } : player,
      ),
    )
  }

  function startGame() {
    dispatch({
      type: 'START_GAME',
      players: playerDrafts.slice(0, playerCount),
    })
  }

  function toggleCardSelection(card: Card) {
    if (state.phase !== 'discard' || currentPlayer?.isBot) {
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

  function discardSelectedCards() {
    if (!selectedCardsAreValid) {
      return
    }

    dispatch({ type: 'DISCARD_CARDS', cardIds: selectedCardIds })
    setSelection({ turnKey, cardIds: [] })
  }

  function resetGame() {
    dispatch({ type: 'RESET_GAME' })
    setSelection({ turnKey: '', cardIds: [] })
    setVisibleTurnKey('')
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">
            {playMode === 'local'
              ? 'Local pass-and-play card game'
              : 'Internet multiplayer card game'}
          </p>
          <h1>Ganji</h1>
          <p className="lede">
            Discard matching values, draw one card, and call Ganji when your hand
            is 5 or less.
          </p>
        </div>
        <div className="header-actions">
          <PlayModeToggle playMode={playMode} onPlayModeChange={setPlayMode} />
          <CardArtworkToggle
            artworkStyle={cardArtworkStyle}
            onArtworkStyleChange={setCardArtworkStyle}
          />
          {playMode === 'local' && state.status !== 'setup' && (
            <button className="ghost-button" type="button" onClick={resetGame}>
              New game
            </button>
          )}
        </div>
      </header>

      {playMode === 'online' ? (
        <OnlineMultiplayer cardArtworkStyle={cardArtworkStyle} />
      ) : state.status === 'setup' ? (
        <SetupScreen
          playerCount={playerCount}
          players={playerDrafts}
          onPlayerCountChange={setPlayerCount}
          onPlayerChange={updatePlayerDraft}
          onStart={startGame}
        />
      ) : (
        <GameScreen
          state={state}
          currentPlayer={currentPlayer}
          cardArtworkStyle={cardArtworkStyle}
          handVisible={handVisible}
          selectedCardIds={selectedCardIds}
          selectedCardsAreValid={selectedCardsAreValid}
          onShowHand={() => setVisibleTurnKey(turnKey)}
          onToggleCard={toggleCardSelection}
          onDiscard={discardSelectedCards}
          onDrawDeck={() => dispatch({ type: 'DRAW_CARD', source: 'deck' })}
          onDrawDiscard={() => dispatch({ type: 'DRAW_CARD', source: 'discard' })}
          onCallGanji={() => dispatch({ type: 'CALL_GANJI' })}
          onNextRound={() => dispatch({ type: 'START_NEXT_ROUND' })}
          onReset={resetGame}
        />
      )}
    </main>
  )
}

type PlayModeToggleProps = {
  playMode: PlayMode
  onPlayModeChange: (playMode: PlayMode) => void
}

function PlayModeToggle({ playMode, onPlayModeChange }: PlayModeToggleProps) {
  return (
    <div className="card-art-toggle">
      <span>Play mode</span>
      <div className="segmented-control" aria-label="Play mode">
        <button
          className={playMode === 'local' ? 'active' : ''}
          type="button"
          onClick={() => onPlayModeChange('local')}
        >
          Local
        </button>
        <button
          className={playMode === 'online' ? 'active' : ''}
          type="button"
          onClick={() => onPlayModeChange('online')}
        >
          Online
        </button>
      </div>
    </div>
  )
}

type CardArtworkToggleProps = {
  artworkStyle: CardArtworkStyle
  onArtworkStyleChange: (artworkStyle: CardArtworkStyle) => void
}

function CardArtworkToggle({
  artworkStyle,
  onArtworkStyleChange,
}: CardArtworkToggleProps) {
  return (
    <div className="card-art-toggle">
      <span>Card art</span>
      <div className="segmented-control" aria-label="Card artwork style">
        <button
          className={artworkStyle === 'standard' ? 'active' : ''}
          type="button"
          onClick={() => onArtworkStyleChange('standard')}
        >
          Standard
        </button>
        <button
          className={artworkStyle === 'simple' ? 'active' : ''}
          type="button"
          onClick={() => onArtworkStyleChange('simple')}
        >
          Simple
        </button>
      </div>
    </div>
  )
}

type SetupScreenProps = {
  playerCount: number
  players: SetupPlayerConfig[]
  onPlayerCountChange: (playerCount: number) => void
  onPlayerChange: (
    playerIndex: number,
    patch: Partial<SetupPlayerConfig>,
  ) => void
  onStart: () => void
}

function SetupScreen({
  playerCount,
  players,
  onPlayerCountChange,
  onPlayerChange,
  onStart,
}: SetupScreenProps) {
  return (
    <section className="setup-grid">
      <div className="panel setup-panel">
        <div className="section-heading">
          <p className="eyebrow">Setup</p>
          <h2>Choose players</h2>
        </div>

        <label className="field-label" htmlFor="player-count">
          Number of players
        </label>
        <select
          id="player-count"
          value={playerCount}
          onChange={(event) => onPlayerCountChange(Number(event.target.value))}
        >
          {Array.from(
            { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
            (_, index) => MIN_PLAYERS + index,
          ).map((count) => (
            <option key={count} value={count}>
              {count} players
            </option>
          ))}
        </select>

        <div className="player-config-list">
          {players.slice(0, playerCount).map((player, index) => (
            <div className="player-config" key={index}>
              <label className="field-label" htmlFor={`player-${index}`}>
                Player {index + 1}
              </label>
              <input
                id={`player-${index}`}
                type="text"
                value={player.name}
                onChange={(event) =>
                  onPlayerChange(index, { name: event.target.value })
                }
              />
              <div className="segmented-control" aria-label={`Player ${index + 1} type`}>
                <button
                  className={!player.isBot ? 'active' : ''}
                  type="button"
                  onClick={() => onPlayerChange(index, { isBot: false })}
                >
                  Human
                </button>
                <button
                  className={player.isBot ? 'active' : ''}
                  type="button"
                  onClick={() => onPlayerChange(index, { isBot: true })}
                >
                  BOT
                </button>
              </div>
            </div>
          ))}
        </div>

        <button className="primary-button" type="button" onClick={onStart}>
          Start Ganji
        </button>
      </div>

      <RulesPanel />
    </section>
  )
}

type OnlineMultiplayerProps = {
  cardArtworkStyle: CardArtworkStyle
}

type OnlineConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'

type SavedOnlineSession = {
  roomCode: string
  sessionId: string
}

function OnlineMultiplayer({ cardArtworkStyle }: OnlineMultiplayerProps) {
  const socketRef = useRef<WebSocket | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<OnlineConnectionStatus>('idle')
  const [playerName, setPlayerName] = useState(loadOnlinePlayerName)
  const [turnTimerSeconds, setTurnTimerSeconds] = useState(60)
  const [joinRoomCode, setJoinRoomCode] = useState('')
  const [room, setRoom] = useState<OnlineRoomView | null>(null)
  const [serverMessage, setServerMessage] = useState(
    'Create an online room or join one with a code.',
  )
  const [savedSession, setSavedSession] = useState<SavedOnlineSession | null>(
    loadSavedOnlineSession,
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

  useEffect(() => {
    try {
      localStorage.setItem(ONLINE_NAME_STORAGE_KEY, playerName)
    } catch {
      // The typed player name is convenient, not required.
    }
  }, [playerName])

  useEffect(() => {
    return () => socketRef.current?.close()
  }, [])

  function connectWithMessage(message: ClientToServerMessage) {
    socketRef.current?.close()
    setConnectionStatus('connecting')
    setServerMessage('Connecting to Ganji server...')

    const socket = new WebSocket(getWebSocketUrl())
    socketRef.current = socket

    socket.addEventListener('open', () => {
      setConnectionStatus('connected')
      socket.send(JSON.stringify(message))
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return
      }

      handleOnlineServerMessage(event.data)
    })

    socket.addEventListener('close', () => {
      setConnectionStatus('disconnected')
      setServerMessage('Disconnected from the Ganji server.')
    })

    socket.addEventListener('error', () => {
      setServerMessage('Could not connect to the Ganji server.')
    })
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
      setServerMessage(message.message)
      return
    }

    setRoom(message.room)
    setServerMessage(message.room.message)

    const session = {
      roomCode: message.room.roomCode,
      sessionId: message.sessionId,
    }
    setSavedSession(session)
    saveOnlineSession(session)
  }

  function sendOnlineMessage(message: ClientToServerMessage) {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setServerMessage('Not connected. Reconnect to continue playing.')
      return
    }

    socketRef.current.send(JSON.stringify(message))
  }

  function createOnlineRoom() {
    connectWithMessage({
      type: 'CREATE_ROOM',
      name: playerName,
      turnTimerSeconds,
    })
  }

  function joinOnlineRoom() {
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

    connectWithMessage({
      type: 'REJOIN_ROOM',
      roomCode: savedSession.roomCode,
      sessionId: savedSession.sessionId,
    })
  }

  function forgetOnlineSession() {
    try {
      localStorage.removeItem(ONLINE_SESSION_STORAGE_KEY)
    } catch {
      // Clearing saved reconnect data is optional.
    }

    setSavedSession(null)
  }

  function toggleOnlineCard(card: Card) {
    if (!gameState || gameState.phase !== 'discard' || !isViewerTurn) {
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
    if (!selectedCardsAreValid) {
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
          onReconnect={reconnectOnlineRoom}
        />
        <GameScreen
          state={room.gameState}
          currentPlayer={currentPlayer}
          cardArtworkStyle={cardArtworkStyle}
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

        <div className="online-actions-grid">
          <button className="primary-button" type="button" onClick={createOnlineRoom}>
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
            <button className="secondary-button" type="button" onClick={joinOnlineRoom}>
              Join room
            </button>
          </div>
        </div>

        {savedSession && (
          <div className="reconnect-card">
            <div>
              <strong>Saved room {savedSession.roomCode}</strong>
              <span>Reconnect if you refreshed or disconnected.</span>
            </div>
            <div className="button-row">
              <button
                className="secondary-button"
                type="button"
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
            onAddBot={() => sendOnlineMessage({ type: 'ADD_BOT' })}
            onRemoveBot={(playerId) =>
              sendOnlineMessage({ type: 'REMOVE_BOT', playerId })
            }
            onKickPlayer={(playerId) =>
              sendOnlineMessage({ type: 'KICK_PLAYER', playerId })
            }
            onSetReady={(ready) => sendOnlineMessage({ type: 'SET_READY', ready })}
            onStartGame={() => sendOnlineMessage({ type: 'START_GAME' })}
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
  onReconnect: () => void
}

function OnlineRoomBar({
  room,
  connectionStatus,
  onReconnect,
}: OnlineRoomBarProps) {
  const remainingSeconds = useTurnTimerRemaining(room.turnDeadline)

  return (
    <section className="online-room-bar panel">
      <div>
        <p className="eyebrow">Online room</p>
        <h2>{room.roomCode}</h2>
      </div>
      <div className="online-room-meta">
        <span>{connectionStatus}</span>
        <span>{room.players.length} players</span>
        <span>Timer: {formatTimerSeconds(room.turnTimerSeconds)}</span>
        {remainingSeconds !== null && <span>Turn: {remainingSeconds}s</span>}
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
  onAddBot: () => void
  onRemoveBot: (playerId: string) => void
  onKickPlayer: (playerId: string) => void
  onSetReady: (ready: boolean) => void
  onStartGame: () => void
  onReconnect: () => void
}

function OnlineLobby({
  room,
  connectionStatus,
  onAddBot,
  onRemoveBot,
  onKickPlayer,
  onSetReady,
  onStartGame,
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
        <span>{isHost ? 'You are host' : 'Waiting for host'}</span>
      </div>

      <div className="lobby-player-list">
        {room.players.map((player) => (
          <div className="lobby-player-row" key={player.id}>
            <div>
              <strong>{player.name}</strong>
              <span>
                {player.isBot
                  ? 'BOT - ready'
                  : `${player.connected ? 'Connected' : 'Disconnected'} - ${
                      player.ready ? 'ready' : 'not ready'
                    }`}
              </span>
            </div>
            {isHost && player.id !== room.hostPlayerId && (
              <div className="button-row compact-buttons">
                {player.isBot ? (
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => onRemoveBot(player.id)}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    className="ghost-button"
                    type="button"
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
            disabled={room.players.length >= MAX_PLAYERS}
            onClick={onAddBot}
          >
            Add BOT
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!canStart}
            onClick={onStartGame}
          >
            Start game
          </button>
        </div>
      ) : (
        <p className="phase-banner">The host will start when the table is ready.</p>
      )}

      {connectionStatus === 'disconnected' && (
        <button className="primary-button" type="button" onClick={onReconnect}>
          Reconnect
        </button>
      )}
    </div>
  )
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
        <li>The host chooses a turn timer, adds BOT players, and can kick humans.</li>
        <li>Humans must mark ready before the host can start the game.</li>
        <li>Rooms are in memory, so they reset if the server restarts.</li>
      </ul>
    </aside>
  )
}

type GameScreenProps = {
  state: GameState
  currentPlayer: Player | undefined
  cardArtworkStyle: CardArtworkStyle
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

  const revealedPlayerId = viewerPlayerId
    ? viewerPlayerId
    : handVisible && currentPlayer && !currentPlayer.isBot
      ? currentPlayer.id
      : null

  return (
    <div className="game-layout">
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
              revealedPlayerId={revealedPlayerId}
              cardArtworkStyle={cardArtworkStyle}
              selectedCardIds={selectedCardIds}
              onToggleCard={onToggleCard}
              onDrawDeck={onDrawDeck}
              onDrawDiscard={onDrawDiscard}
              canUseTableDraws={
                (!viewerPlayerId || viewerPlayerId === currentPlayer.id) &&
                !currentPlayer.isBot
              }
            />
            <TableActionArea
              state={state}
              player={currentPlayer}
              viewerPlayerId={viewerPlayerId}
              handVisible={handVisible}
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
    const summary = state.roundSummary
    if (!summary) {
      return
    }

    const resultKey = `${summary.roundNumber}:${summary.callerId}:${summary.callerHadLowest}`
    if (playedResultKeyRef.current === resultKey) {
      return
    }

    playedResultKeyRef.current = resultKey
    const audio = new Audio(
      summary.callerHadLowest ? GANJI_SUCCESS_AUDIO : GANJI_FAIL_AUDIO,
    )

    audio.play().catch(() => {
      // Browsers can block audio until the user interacts with the page.
    })
  }, [state.roundSummary])
}

type TableSurfaceProps = {
  state: GameState
  currentPlayerId: string
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
          <span className="slot-action">
            {state.phase === 'draw' ? 'Draw from deck' : 'Available after discard'}
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
              : 'First turn has no discard'}
          </span>
          <span className="slot-action">
            {state.phase === 'draw'
              ? latestDiscard
                ? 'Draw this card'
                : 'No card to draw'
              : 'You can see this before discarding'}
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
              ? `For the next player from ${justDiscarded.fromPlayerName}`
              : 'Your discard will land here'}
          </span>
          <span className="slot-action">Not drawable this turn</span>
        </div>
      </div>
    </section>
  )
}

type PlayerHandsOnTableProps = {
  players: Player[]
  currentPlayerId: string
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
        const seatStyle = getPlayerSeatStyle(players.length, index)

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
                <span>{formatCount(player.hand.length, 'card')}</span>
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

function getPlayerSeatStyle(playerCount: number, playerIndex: number): SeatStyle {
  const startAngle = 135
  const angle = ((startAngle + (360 / playerCount) * playerIndex) * Math.PI) / 180
  const x = 50 + 43 * Math.cos(angle)
  const y = 50 + 39 * Math.sin(angle)

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
        <p>
          Pass the laptop to {player.name}, then reveal the cards when other
          players are not looking.
        </p>
        <button className="primary-button" type="button" onClick={onShowHand}>
          Unhide {player.name}'s cards
        </button>
      </div>
    )
  }

  return (
    <div className="table-action-area">
      <PhaseBanner phase={state.phase} />

      {state.phase === 'discard' && (
        <div className="action-panel">
          <p>
            Select one card, or several cards with the same value. Selected:{' '}
            {selectedCards.length === 0
              ? 'none'
              : selectedCards.map(cardLabel).join(', ')}
          </p>
          {selectedCards.length > 1 && !selectedCardsAreValid && (
            <p className="warning-text">Selected cards do not share one value.</p>
          )}
          <div className="button-row">
            <button
              className="primary-button"
              type="button"
              disabled={!selectedCardsAreValid}
              onClick={onDiscard}
            >
              Discard selected
            </button>
            <GanjiButton
              canCall={canCallGanji}
              onCall={onCallGanji}
            />
          </div>
        </div>
      )}

      {state.phase === 'draw' && (
        <div className="action-panel">
          <DrawChoices state={state} />
        </div>
      )}

      {state.phase === 'postDraw' && (
        <div className="action-panel">
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
      <p>Draw exactly one card from the table above.</p>
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
  onCall: () => void
}

function GanjiButton({ canCall, onCall }: GanjiButtonProps) {
  return (
    <button
      className="ganji-button"
      type="button"
      disabled={!canCall}
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
        <p className="eyebrow">Race to avoid {GAME_OVER_SCORE}</p>
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
  onNextRound: () => void
}

function RoundResult({
  state,
  cardArtworkStyle,
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

      <button className="primary-button" type="button" onClick={onNextRound}>
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
  const winners = state.players.filter((player) => state.winnerIds.includes(player.id))

  return (
    <div className="result-card game-over-card">
      <div className="result-heading">
        <div>
          <p className="eyebrow">Game over</p>
          <h2>{winners.length > 1 ? 'Winners' : 'Winner'}: {winners.map((player) => player.name).join(', ')}</h2>
        </div>
        <p>
          Someone reached {GAME_OVER_SCORE}+ total points. Lowest total score wins.
        </p>
      </div>

      <ScoreTable state={state} cardArtworkStyle={cardArtworkStyle} />

      <button className="primary-button" type="button" onClick={onReset}>
        Play again
      </button>
    </div>
  )
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

function RulesPanel() {
  return (
    <aside className="panel rules-panel">
      <div className="section-heading">
        <p className="eyebrow">Rules included</p>
        <h2>How this version plays</h2>
      </div>
      <ul>
        <li>Uses one 52-card deck, with 4 cards dealt to each player.</li>
        <li>Black kings are worth 0. Aces are 1, jacks 11, queens 12, kings 13.</li>
        <li>Each turn discards first, then draws one card.</li>
        <li>Only the last card discarded by the previous player can be drawn.</li>
        <li>Ganji can be called only as the first action of your turn.</li>
        <li>Your hand value must be 5 or less to call Ganji.</li>
        <li>The game ends when any player reaches 100 or more total points.</li>
      </ul>
    </aside>
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

function createDefaultPlayers(): SetupPlayerConfig[] {
  return Array.from({ length: MAX_PLAYERS }, (_, index) => ({
    name: index === 0 ? 'Player 1' : `Player ${index + 1}`,
    isBot: index > 0,
  }))
}

function loadCardArtworkStyle(): CardArtworkStyle {
  try {
    return localStorage.getItem(CARD_ARTWORK_STORAGE_KEY) === 'simple'
      ? 'simple'
      : 'standard'
  } catch {
    return 'standard'
  }
}

function getWebSocketUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined
  if (configuredUrl) {
    return configuredUrl
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

  if (import.meta.env.DEV) {
    return `${protocol}//${window.location.hostname}:3001/ws`
  }

  return `${protocol}//${window.location.host}/ws`
}

function loadOnlinePlayerName(): string {
  try {
    return localStorage.getItem(ONLINE_NAME_STORAGE_KEY) ?? 'Player'
  } catch {
    return 'Player'
  }
}

function loadSavedOnlineSession(): SavedOnlineSession | null {
  try {
    const savedSession = localStorage.getItem(ONLINE_SESSION_STORAGE_KEY)
    if (!savedSession) {
      return null
    }

    const parsedSession = JSON.parse(savedSession) as SavedOnlineSession
    return parsedSession.roomCode && parsedSession.sessionId ? parsedSession : null
  } catch {
    localStorage.removeItem(ONLINE_SESSION_STORAGE_KEY)
    return null
  }
}

function saveOnlineSession(session: SavedOnlineSession) {
  try {
    localStorage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Reconnect support is useful, but the game can continue without it.
  }
}

function formatTimerSeconds(seconds: number): string {
  const option = TURN_TIMER_OPTIONS.find((item) => item.seconds === seconds)
  return option?.label ?? `${seconds}s`
}

function loadSavedGame(): GameState {
  try {
    const savedGame = localStorage.getItem(STORAGE_KEY)
    if (!savedGame) {
      return initialGameState
    }

    const parsedGame = JSON.parse(savedGame) as GameState
    if (Array.isArray(parsedGame.players) && parsedGame.players.length >= MIN_PLAYERS) {
      return parsedGame
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY)
  }

  return initialGameState
}

export default App
