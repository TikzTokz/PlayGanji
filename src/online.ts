import type { DrawSource, GameState, SetupPlayerConfig } from './game'

export type OnlineRoomStatus = 'lobby' | 'playing' | 'roundOver' | 'gameOver'

export type OnlineLobbyPlayer = SetupPlayerConfig & {
  id: string
  connected: boolean
  ready: boolean
  substituteActive: boolean
}

export type OnlineRoomView = {
  roomCode: string
  status: OnlineRoomStatus
  players: OnlineLobbyPlayer[]
  gameState: GameState | null
  viewerPlayerId: string
  hostPlayerId: string
  turnTimerSeconds: number
  turnDeadline: number | null
  message: string
}

export type ClientToServerMessage =
  | { type: 'CREATE_ROOM'; name: string; turnTimerSeconds: number }
  | { type: 'JOIN_ROOM'; roomCode: string; name: string }
  | { type: 'REJOIN_ROOM'; roomCode: string; sessionId: string }
  | { type: 'ADD_BOT' }
  | { type: 'REMOVE_BOT'; playerId: string }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'KICK_PLAYER'; playerId: string }
  | { type: 'DELETE_ROOM' }
  | { type: 'START_GAME' }
  | { type: 'DISCARD_CARDS'; cardIds: string[] }
  | { type: 'DRAW_CARD'; source: DrawSource }
  | { type: 'CALL_GANJI' }
  | { type: 'END_TURN' }
  | { type: 'START_NEXT_ROUND' }

export type ServerToClientMessage =
  | { type: 'ROOM_UPDATE'; room: OnlineRoomView; sessionId: string }
  | { type: 'ROOM_CLOSED'; roomCode: string; message: string }
  | { type: 'ERROR'; message: string }
