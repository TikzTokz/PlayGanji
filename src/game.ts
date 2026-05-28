export const MIN_PLAYERS = 3
export const MAX_PLAYERS = 6
export const GANJI_LIMIT = 5
export const GAME_OVER_SCORE = 100

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
  roundSummary: RoundSummary | null
  winnerIds: string[]
  message: string
}

export type DrawSource = 'deck' | 'discard'

export type GameAction =
  | { type: 'START_GAME'; players: SetupPlayerConfig[] }
  | { type: 'DISCARD_CARDS'; cardIds: string[] }
  | { type: 'DRAW_CARD'; source: DrawSource }
  | { type: 'END_TURN' }
  | { type: 'CALL_GANJI' }
  | { type: 'START_NEXT_ROUND' }
  | { type: 'RESET_GAME' }

const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs']
const ranks: Rank[] = [
  'A',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
]

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

export const initialGameState: GameState = {
  status: 'setup',
  phase: 'discard',
  players: [],
  deck: [],
  discardPile: [],
  drawOffer: null,
  pendingNextOffer: null,
  currentPlayerIndex: 0,
  roundNumber: 0,
  roundSummary: null,
  winnerIds: [],
  message: 'Choose players to start Ganji.',
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'START_GAME': {
      const players = action.players
        .slice(0, MAX_PLAYERS)
        .map((player, index): Player => ({
          id: player.id ?? `player-${index + 1}`,
          name: normalizePlayerName(player.name, index),
          isBot: player.isBot,
          hand: [],
          totalScore: 0,
        }))

      if (players.length < MIN_PLAYERS) {
        return withMessage(state, `Ganji needs at least ${MIN_PLAYERS} players.`)
      }

      return startRound(players, 1)
    }

    case 'DISCARD_CARDS': {
      if (state.status !== 'playing' || state.phase !== 'discard') {
        return withMessage(state, 'Discard cards at the start of your turn.')
      }

      const currentPlayer = state.players[state.currentPlayerIndex]
      const selectedIds = new Set(action.cardIds)
      const selectedCards = currentPlayer.hand.filter((card) =>
        selectedIds.has(card.id),
      )

      if (selectedCards.length === 0) {
        return withMessage(state, 'Select at least one card to discard.')
      }

      if (selectedCards.length !== selectedIds.size) {
        return withMessage(state, 'One or more selected cards are not in hand.')
      }

      if (!cardsShareValue(selectedCards)) {
        return withMessage(state, 'Discarded cards must all have the same value.')
      }

      const remainingHand = currentPlayer.hand.filter(
        (card) => !selectedIds.has(card.id),
      )
      const latestDiscard = selectedCards[selectedCards.length - 1]
      const buriedDiscards = selectedCards.slice(0, -1)
      const players = replacePlayerHand(
        state.players,
        state.currentPlayerIndex,
        remainingHand,
      )

      return {
        ...state,
        players,
        phase: 'draw',
        discardPile: [...state.discardPile, ...buriedDiscards],
        pendingNextOffer: {
          card: latestDiscard,
          fromPlayerId: currentPlayer.id,
          fromPlayerName: currentPlayer.name,
          discardedCount: selectedCards.length,
        },
        message: `${currentPlayer.name} discarded ${formatCount(
          selectedCards.length,
          'card',
        )}. Draw one card to finish the turn.`,
      }
    }

    case 'DRAW_CARD': {
      if (state.status !== 'playing' || state.phase !== 'draw') {
        return withMessage(state, 'Draw after discarding cards.')
      }

      const currentPlayer = state.players[state.currentPlayerIndex]
      let deck = [...state.deck]
      let discardPile = [...state.discardPile]
      let drawnCard: Card
      let recycled = false

      if (action.source === 'discard') {
        if (!state.drawOffer) {
          return withMessage(state, 'There is no previous discard to draw.')
        }

        drawnCard = state.drawOffer.card
      } else {
        const drawResult = drawOneFromDeck(deck, discardPile)
        if (!drawResult.card) {
          return withMessage(state, 'There are no cards available to draw.')
        }

        drawnCard = drawResult.card
        deck = drawResult.deck
        discardPile = state.drawOffer
          ? [...drawResult.discardPile, state.drawOffer.card]
          : drawResult.discardPile
        recycled = drawResult.recycled
      }

      const players = replacePlayerHand(state.players, state.currentPlayerIndex, [
        ...currentPlayer.hand,
        drawnCard,
      ])
      const sourceText =
        action.source === 'discard'
          ? `drew ${cardName(drawnCard)} from ${state.drawOffer?.fromPlayerName}'s discard`
          : 'drew from the deck'
      const recycleText = recycled ? ' The discard pile was shuffled into the deck.' : ''

      if (!state.pendingNextOffer) {
        return withMessage(state, 'Discard a card before drawing.')
      }

      const nextPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length
      const nextPlayer = players[nextPlayerIndex]

      return {
        ...state,
        players,
        deck,
        discardPile,
        currentPlayerIndex: nextPlayerIndex,
        drawOffer: state.pendingNextOffer,
        pendingNextOffer: null,
        phase: 'discard',
        message: `${currentPlayer.name} ${sourceText}.${recycleText} ${nextPlayer.name}'s turn.`,
      }
    }

    case 'END_TURN': {
      if (state.status !== 'playing' || state.phase !== 'postDraw') {
        return withMessage(state, 'Finish your draw before ending the turn.')
      }

      if (!state.pendingNextOffer) {
        return withMessage(state, 'Discard a card before ending the turn.')
      }

      const nextPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length
      const nextPlayer = state.players[nextPlayerIndex]

      return {
        ...state,
        phase: 'discard',
        currentPlayerIndex: nextPlayerIndex,
        drawOffer: state.pendingNextOffer,
        pendingNextOffer: null,
        message: `${nextPlayer.name}'s turn. Discard first, then draw one card.`,
      }
    }

    case 'CALL_GANJI': {
      if (state.status !== 'playing') {
        return withMessage(state, 'Start a game before calling Ganji.')
      }

      if (state.phase !== 'discard') {
        return withMessage(
          state,
          'Ganji can only be called as the first action of your turn.',
        )
      }

      const currentPlayer = state.players[state.currentPlayerIndex]
      const handValue = calculateHandValue(currentPlayer.hand)

      if (handValue > GANJI_LIMIT) {
        return withMessage(
          state,
          `${currentPlayer.name} cannot call Ganji with ${handValue} points.`,
        )
      }

      return finishRound(state, currentPlayer)
    }

    case 'START_NEXT_ROUND': {
      if (state.status !== 'roundOver') {
        return withMessage(state, 'The current round is still in progress.')
      }

      return startRound(state.players, state.roundNumber + 1)
    }

    case 'RESET_GAME':
      return initialGameState
  }
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

export function chooseBotDiscard(hand: Card[]): Card[] {
  const groups = new Map<number, Card[]>()

  for (const card of hand) {
    const cards = groups.get(card.value) ?? []
    cards.push(card)
    groups.set(card.value, cards)
  }

  let bestCards: Card[] = []
  let bestScore = Number.NEGATIVE_INFINITY

  for (const cards of groups.values()) {
    const discardScore = cards[0].value * cards.length
    const isBetterScore = discardScore > bestScore
    const isBetterTie =
      discardScore === bestScore && cards.length > bestCards.length

    if (isBetterScore || isBetterTie) {
      bestCards = cards
      bestScore = discardScore
    }
  }

  return bestCards
}

export function chooseBotDrawSource(state: GameState): DrawSource {
  if (!state.drawOffer) {
    return 'deck'
  }

  const hasIndependentDeck = state.deck.length > 0 || state.discardPile.length > 0
  if (!hasIndependentDeck) {
    return 'discard'
  }

  const currentPlayer = state.players[state.currentPlayerIndex]
  const projectedValue = calculateHandValue(currentPlayer.hand) + state.drawOffer.card.value

  if (state.drawOffer.card.value <= 4 || projectedValue <= GANJI_LIMIT) {
    return 'discard'
  }

  return 'deck'
}

export function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function startRound(players: Player[], roundNumber: number): GameState {
  const deck = shuffle(createDeck())
  const roundPlayers = players.map((player): Player => ({ ...player, hand: [] }))

  for (let cardIndex = 0; cardIndex < 4; cardIndex += 1) {
    for (const player of roundPlayers) {
      const card = deck.shift()
      if (card) {
        player.hand = [...player.hand, card]
      }
    }
  }

  return {
    status: 'playing',
    phase: 'discard',
    players: roundPlayers,
    deck,
    discardPile: [],
    drawOffer: null,
    pendingNextOffer: null,
    currentPlayerIndex: 0,
    roundNumber,
    roundSummary: null,
    winnerIds: [],
    message: `Round ${roundNumber} started. ${roundPlayers[0].name} takes the first turn.`,
  }
}

function finishRound(state: GameState, caller: Player): GameState {
  const handValues = new Map(
    state.players.map((player) => [player.id, calculateHandValue(player.hand)]),
  )
  const callerHandValue = handValues.get(caller.id) ?? 0
  const lowestHandValue = Math.min(...handValues.values())
  const callerHadLowest = callerHandValue === lowestHandValue

  const roundScores = state.players.map((player) => {
    const handValue = handValues.get(player.id) ?? 0
    const isCaller = player.id === caller.id
    const penaltyApplied = isCaller && !callerHadLowest
    const roundPoints = isCaller
      ? callerHadLowest
        ? 0
        : handValue + 25
      : handValue

    return {
      playerId: player.id,
      playerName: player.name,
      handValue,
      roundPoints,
      totalScore: player.totalScore + roundPoints,
      isCaller,
      penaltyApplied,
    }
  })

  const players = state.players.map((player) => {
    const score = roundScores.find((roundScore) => roundScore.playerId === player.id)
    return {
      ...player,
      totalScore: score?.totalScore ?? player.totalScore,
    }
  })
  const gameOver = players.some((player) => player.totalScore >= GAME_OVER_SCORE)
  const lowestTotal = Math.min(...players.map((player) => player.totalScore))
  const winnerIds = gameOver
    ? players
        .filter((player) => player.totalScore === lowestTotal)
        .map((player) => player.id)
    : []
  const status: GameStatus = gameOver ? 'gameOver' : 'roundOver'
  const resultText = callerHadLowest
    ? `${caller.name} called Ganji successfully.`
    : `${caller.name} missed Ganji and took a 25 point penalty.`

  return {
    ...state,
    status,
    phase: 'discard',
    players,
    drawOffer: null,
    pendingNextOffer: null,
    roundSummary: {
      roundNumber: state.roundNumber,
      callerId: caller.id,
      callerName: caller.name,
      callerHandValue,
      lowestHandValue,
      callerHadLowest,
      scores: roundScores,
    },
    winnerIds,
    message: resultText,
  }
}

function createDeck(): Card[] {
  return suits.flatMap((suit) =>
    ranks.map((rank) => ({
      id: `${rank}-${suit}`,
      rank,
      suit,
      value: cardValue(rank, suit),
    })),
  )
}

function cardValue(rank: Rank, suit: Suit): number {
  if (rank === 'K' && (suit === 'spades' || suit === 'clubs')) {
    return 0
  }

  if (rank === 'A') {
    return 1
  }

  if (rank === 'J') {
    return 11
  }

  if (rank === 'Q') {
    return 12
  }

  if (rank === 'K') {
    return 13
  }

  return Number(rank)
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items]

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const item = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = item
  }

  return shuffled
}

function drawOneFromDeck(
  deck: Card[],
  discardPile: Card[],
): { card: Card | null; deck: Card[]; discardPile: Card[]; recycled: boolean } {
  let nextDeck = [...deck]
  let nextDiscardPile = [...discardPile]
  let recycled = false

  if (nextDeck.length === 0 && nextDiscardPile.length > 0) {
    nextDeck = shuffle(nextDiscardPile)
    nextDiscardPile = []
    recycled = true
  }

  const card = nextDeck[0] ?? null
  return {
    card,
    deck: nextDeck.slice(1),
    discardPile: nextDiscardPile,
    recycled,
  }
}

function replacePlayerHand(
  players: Player[],
  playerIndex: number,
  hand: Card[],
): Player[] {
  return players.map((player, index) =>
    index === playerIndex ? { ...player, hand } : player,
  )
}

function normalizePlayerName(name: string, index: number): string {
  const trimmedName = name.trim()
  return trimmedName.length > 0 ? trimmedName : `Player ${index + 1}`
}

function withMessage(state: GameState, message: string): GameState {
  return { ...state, message }
}
