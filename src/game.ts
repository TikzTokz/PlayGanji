export const MIN_PLAYERS = 3
export const MAX_PLAYERS = 6
export const GANJI_LIMIT = 5
export const GAME_OVER_SCORE = 100
export const GAME_OVER_SCORE_OPTIONS = [50, 100, 150, 200] as const

export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs'
export type Rank =
  | 'A'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | '10'
  | 'J'
  | 'Q'
  | 'K'

export type Card = {
  id: string
  rank: Rank
  suit: Suit
  value: number
}

export type Player = {
  id: string
  name: string
  isBot: boolean
  hand: Card[]
  totalScore: number
}

export type SetupPlayerConfig = {
  id?: string
  name: string
  isBot: boolean
}

export type DrawOffer = {
  card: Card
  fromPlayerId: string
  fromPlayerName: string
  discardedCount: number
}

export type GameStatus = 'setup' | 'playing' | 'roundOver' | 'gameOver'
export type TurnPhase = 'discard' | 'draw' | 'postDraw'

export type RoundScore = {
  playerId: string
  playerName: string
  handValue: number
  roundPoints: number
  totalScore: number
  isCaller: boolean
  penaltyApplied: boolean
}

export type RoundSummary = {
  roundNumber: number
  callerId: string
  callerName: string
  callerHandValue: number
  lowestHandValue: number
  callerHadLowest: boolean
  scores: RoundScore[]
}

export type GameState = {
  status: GameStatus
  phase: TurnPhase
  players: Player[]
  deck: Card[]
  discardPile: Card[]
  drawOffer: DrawOffer | null
  pendingNextOffer: DrawOffer | null
  currentPlayerIndex: number
  roundNumber: number
  gameOverScore: number
  roundSummary: RoundSummary | null
  winnerIds: string[]
  message: string
}

export type DrawSource = 'deck' | 'discard'

const suitShortNames: Record<Suit, string> = {
  spades: 'S',
  hearts: 'H',
  diamonds: 'D',
  clubs: 'C',
}

const suitNames: Record<Suit, string> = {
  spades: 'Spades',
  hearts: 'Hearts',
  diamonds: 'Diamonds',
  clubs: 'Clubs',
}

const rankNames: Record<Rank, string> = {
  A: 'Ace',
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  '10': '10',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
}

export function calculateHandValue(hand: Card[]): number {
  return hand.reduce((sum, card) => sum + card.value, 0)
}

export function cardLabel(card: Card): string {
  return `${card.rank}${suitShortNames[card.suit]}`
}

export function cardName(card: Card): string {
  return `${rankNames[card.rank]} of ${suitNames[card.suit]}`
}

export function isRedSuit(suit: Suit): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

export function cardsShareValue(cards: Card[]): boolean {
  return cards.every((card) => card.value === cards[0]?.value)
}

export function canDrawFromDeck(state: GameState): boolean {
  if (state.status !== 'playing' || state.phase !== 'draw') {
    return false
  }

  return state.deck.length > 0 || state.discardPile.length > 0
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}
