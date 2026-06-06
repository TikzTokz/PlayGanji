import type { DrawSource, GameState, SetupPlayerConfig } from './game'

export type OnlineRoomStatus = 'lobby' | 'playing' | 'roundOver' | 'gameOver'

export type OnlineLobbyPlayer = SetupPlayerConfig & {
  id: string
  connected: boolean
  ready: boolean
  substituteActive: boolean
}

export type OnlineChatMessage = {
  id: string
  playerId: string
  playerName: string
  text: string
  sentAt: number
}

export type VoiceSessionDescription = {
  type: 'offer' | 'answer'
  sdp: string
}

export type VoiceIceCandidate = {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
  usernameFragment?: string | null
}

export type VoiceSignalPayload =
  | { kind: 'offer'; description: VoiceSessionDescription }
  | { kind: 'answer'; description: VoiceSessionDescription }
  | { kind: 'ice-candidate'; candidate: VoiceIceCandidate }

export type OnlineRoomView = {
  roomCode: string
  status: OnlineRoomStatus
  players: OnlineLobbyPlayer[]
  gameState: GameState | null
  viewerPlayerId: string
  hostPlayerId: string
  turnTimerSeconds: number
  gameOverScore: number
  turnDeadline: number | null
  chatMessages: OnlineChatMessage[]
  voicePlayerIds: string[]
  message: string
}

export type ClientToServerMessage =
  | { type: 'CREATE_ROOM'; name: string; turnTimerSeconds: number; gameOverScore: number }
  | { type: 'JOIN_ROOM'; roomCode: string; name: string }
  | { type: 'REJOIN_ROOM'; roomCode: string; sessionId: string }
  | { type: 'ADD_BOT' }
  | { type: 'REMOVE_BOT'; playerId: string }
  | { type: 'SET_READY'; ready: boolean }
  | { type: 'KICK_PLAYER'; playerId: string }
  | { type: 'LEAVE_ROOM' }
  | { type: 'DELETE_ROOM' }
  | { type: 'START_GAME' }
  | { type: 'DISCARD_CARDS'; cardIds: string[] }
  | { type: 'DRAW_CARD'; source: DrawSource }
  | { type: 'CALL_GANJI' }
  | { type: 'END_TURN' }
  | { type: 'START_NEXT_ROUND' }
  | { type: 'SEND_CHAT_MESSAGE'; text: string }
  | { type: 'VOICE_JOIN' }
  | { type: 'VOICE_LEAVE' }
  | { type: 'VOICE_SIGNAL'; targetPlayerId: string; signal: VoiceSignalPayload }

export type ServerToClientMessage =
  | { type: 'ROOM_UPDATE'; room: OnlineRoomView; sessionId: string }
  | { type: 'ROOM_CLOSED'; roomCode: string; message: string }
  | { type: 'CHAT_MESSAGE'; message: OnlineChatMessage }
  | { type: 'VOICE_PEER_JOINED'; playerId: string }
  | { type: 'VOICE_PEER_LEFT'; playerId: string }
  | { type: 'VOICE_SIGNAL'; fromPlayerId: string; signal: VoiceSignalPayload }
  | { type: 'ERROR'; code?: string; message: string }
