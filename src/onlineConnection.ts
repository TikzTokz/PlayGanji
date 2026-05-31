export type OnlineConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export type SavedOnlineSession = {
  roomCode: string
  sessionId: string
}

export const ONLINE_NAME_STORAGE_KEY = 'ganji-online-player-name-v1'
export const ONLINE_SESSION_STORAGE_KEY = 'ganji-online-session-v1'

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000]

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type WebSocketUrlOptions = {
  configuredUrl?: string
  protocol: string
  hostname: string
  host: string
  dev: boolean
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type ReconnectCheckResult = 'valid' | 'invalid' | 'unknown'

export function getReconnectDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RECONNECT_DELAYS_MS.length - 1))
  return RECONNECT_DELAYS_MS[index]
}

export function isInvalidReconnectMessage(message: string): boolean {
  return message === 'Room not found.' || message === 'Saved session was not found for this room.'
}

export function resolveWebSocketUrl({
  configuredUrl,
  protocol,
  hostname,
  host,
  dev,
}: WebSocketUrlOptions): string {
  if (configuredUrl) {
    return configuredUrl
  }

  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
  return dev ? `${wsProtocol}//${hostname}:3001/ws` : `${wsProtocol}//${host}/ws`
}

export function resolveReconnectCheckUrl({
  configuredUrl,
  protocol,
  hostname,
  host,
  dev,
}: WebSocketUrlOptions): string {
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl)
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
      url.pathname = '/api/reconnect-check'
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return configuredUrl
    }
  }

  const httpProtocol = protocol === 'https:' ? 'https:' : 'http:'
  return dev
    ? `${httpProtocol}//${hostname}:3001/api/reconnect-check`
    : `${httpProtocol}//${host}/api/reconnect-check`
}

export async function checkSavedOnlineSession(
  fetcher: FetchLike,
  checkUrl: string,
  session: SavedOnlineSession,
): Promise<ReconnectCheckResult> {
  try {
    const response = await fetcher(checkUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(session),
    })

    if (!response.ok) {
      return 'unknown'
    }

    const result = (await response.json()) as { canReconnect?: boolean }
    return result.canReconnect ? 'valid' : 'invalid'
  } catch {
    return 'unknown'
  }
}

export function loadOnlinePlayerName(storage: StorageLike): string {
  try {
    return storage.getItem(ONLINE_NAME_STORAGE_KEY) ?? 'Player'
  } catch {
    return 'Player'
  }
}

export function saveOnlinePlayerName(storage: StorageLike, playerName: string) {
  try {
    storage.setItem(ONLINE_NAME_STORAGE_KEY, playerName)
  } catch {
    // The typed player name is convenient, not required.
  }
}

export function loadSavedOnlineSession(storage: StorageLike): SavedOnlineSession | null {
  try {
    const savedSession = storage.getItem(ONLINE_SESSION_STORAGE_KEY)
    if (!savedSession) {
      return null
    }

    const parsedSession = JSON.parse(savedSession) as SavedOnlineSession
    return parsedSession.roomCode && parsedSession.sessionId ? parsedSession : null
  } catch {
    try {
      storage.removeItem(ONLINE_SESSION_STORAGE_KEY)
    } catch {
      // Clearing invalid reconnect data is optional.
    }
    return null
  }
}

export function saveOnlineSession(storage: StorageLike, session: SavedOnlineSession) {
  try {
    storage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Reconnect support is useful, but the game can continue without it.
  }
}

export function forgetOnlineSession(storage: StorageLike) {
  try {
    storage.removeItem(ONLINE_SESSION_STORAGE_KEY)
  } catch {
    // Clearing saved reconnect data is optional.
  }
}
