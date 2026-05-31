import { describe, expect, it } from 'vitest'
import {
  calculateHandValue,
  canDrawFromDeck,
  cardLabel,
  cardName,
  cardsShareValue,
  type Card,
  type GameState,
} from './game'

const aceSpades: Card = { id: 'A-spades', rank: 'A', suit: 'spades', value: 1 }
const fiveHearts: Card = { id: '5-hearts', rank: '5', suit: 'hearts', value: 5 }
const fiveClubs: Card = { id: '5-clubs', rank: '5', suit: 'clubs', value: 5 }

function createGameState(patch: Partial<GameState>): GameState {
  return {
    status: 'playing',
    phase: 'draw',
    players: [],
    deck: [aceSpades],
    discardPile: [],
    drawOffer: null,
    pendingNextOffer: null,
    currentPlayerIndex: 0,
    roundNumber: 1,
    gameOverScore: 100,
    roundSummary: null,
    winnerIds: [],
    message: '',
    ...patch,
  }
}

describe('frontend game helpers', () => {
  it('calculates hand values', () => {
    expect(calculateHandValue([aceSpades, fiveHearts])).toBe(6)
  })

  it('checks whether selected cards share a value', () => {
    expect(cardsShareValue([fiveHearts, fiveClubs])).toBe(true)
    expect(cardsShareValue([aceSpades, fiveClubs])).toBe(false)
  })

  it('formats card labels and names', () => {
    expect(cardLabel(aceSpades)).toBe('AS')
    expect(cardName(fiveHearts)).toBe('5 of Hearts')
  })

  it('allows drawing from the deck only during the draw phase with available cards', () => {
    expect(canDrawFromDeck(createGameState({ phase: 'draw', deck: [aceSpades] }))).toBe(true)
    expect(canDrawFromDeck(createGameState({ phase: 'draw', deck: [], discardPile: [fiveClubs] }))).toBe(true)
    expect(canDrawFromDeck(createGameState({ phase: 'discard', deck: [aceSpades] }))).toBe(false)
    expect(canDrawFromDeck(createGameState({ status: 'roundOver', deck: [aceSpades] }))).toBe(false)
    expect(canDrawFromDeck(createGameState({ deck: [], discardPile: [] }))).toBe(false)
  })
})
