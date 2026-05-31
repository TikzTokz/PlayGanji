import { describe, expect, it } from 'vitest'
import {
  ONLINE_NAME_STORAGE_KEY,
  ONLINE_SESSION_STORAGE_KEY,
  forgetOnlineSession,
  getReconnectDelayMs,
  isInvalidReconnectMessage,
  loadOnlinePlayerName,
  loadSavedOnlineSession,
  resolveWebSocketUrl,
  saveOnlinePlayerName,
  saveOnlineSession,
} from './onlineConnection'

function createStorage() {
  const values = new Map<string, string>()

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

describe('online connection helpers', () => {
  it('resolves websocket URLs for configured, dev, and production modes', () => {
    expect(
      resolveWebSocketUrl({
        configuredUrl: 'wss://example.test/custom',
        protocol: 'https:',
        hostname: 'play.test',
        host: 'play.test',
        dev: false,
      }),
    ).toBe('wss://example.test/custom')

    expect(
      resolveWebSocketUrl({
        protocol: 'http:',
        hostname: 'localhost',
        host: 'localhost:5173',
        dev: true,
      }),
    ).toBe('ws://localhost:3001/ws')

    expect(
      resolveWebSocketUrl({
        protocol: 'https:',
        hostname: 'play.test',
        host: 'play.test',
        dev: false,
      }),
    ).toBe('wss://play.test/ws')
  })

  it('saves and loads the player name', () => {
    const storage = createStorage()

    expect(loadOnlinePlayerName(storage)).toBe('Player')
    saveOnlinePlayerName(storage, 'Sam')

    expect(storage.getItem(ONLINE_NAME_STORAGE_KEY)).toBe('Sam')
    expect(loadOnlinePlayerName(storage)).toBe('Sam')
  })

  it('saves, loads, and forgets reconnect sessions', () => {
    const storage = createStorage()
    const session = { roomCode: 'ABC123', sessionId: 'session-1' }

    expect(loadSavedOnlineSession(storage)).toBeNull()

    saveOnlineSession(storage, session)

    expect(storage.getItem(ONLINE_SESSION_STORAGE_KEY)).toBe(JSON.stringify(session))
    expect(loadSavedOnlineSession(storage)).toEqual(session)

    forgetOnlineSession(storage)

    expect(loadSavedOnlineSession(storage)).toBeNull()
  })

  it('drops malformed reconnect sessions', () => {
    const storage = createStorage()
    storage.setItem(ONLINE_SESSION_STORAGE_KEY, '{not-json')

    expect(loadSavedOnlineSession(storage)).toBeNull()
    expect(storage.getItem(ONLINE_SESSION_STORAGE_KEY)).toBeNull()
  })

  it('caps reconnect delay at ten seconds', () => {
    expect(getReconnectDelayMs(0)).toBe(1000)
    expect(getReconnectDelayMs(1)).toBe(2000)
    expect(getReconnectDelayMs(4)).toBe(10000)
    expect(getReconnectDelayMs(20)).toBe(10000)
  })

  it('identifies server errors that invalidate saved reconnect data', () => {
    expect(isInvalidReconnectMessage('Room not found.')).toBe(true)
    expect(isInvalidReconnectMessage('Saved session was not found for this room.')).toBe(true)
    expect(isInvalidReconnectMessage('Could not connect to the Ganji server.')).toBe(false)
  })
})
