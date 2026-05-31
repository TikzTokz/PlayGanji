package game

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
)

const (
	MinPlayers    = 3
	MaxPlayers    = 6
	GanjiLimit    = 5
	GameOverScore = 100
)

var GameOverScoreOptions = []int{50, 100, 150, 200}

type Suit string
type Rank string
type GameStatus string
type TurnPhase string
type DrawSource string

const (
	SuitSpades   Suit = "spades"
	SuitHearts   Suit = "hearts"
	SuitDiamonds Suit = "diamonds"
	SuitClubs    Suit = "clubs"

	RankAce   Rank = "A"
	RankTwo   Rank = "2"
	RankThree Rank = "3"
	RankFour  Rank = "4"
	RankFive  Rank = "5"
	RankSix   Rank = "6"
	RankSeven Rank = "7"
	RankEight Rank = "8"
	RankNine  Rank = "9"
	RankTen   Rank = "10"
	RankJack  Rank = "J"
	RankQueen Rank = "Q"
	RankKing  Rank = "K"

	StatusSetup     GameStatus = "setup"
	StatusPlaying   GameStatus = "playing"
	StatusRoundOver GameStatus = "roundOver"
	StatusGameOver  GameStatus = "gameOver"

	PhaseDiscard  TurnPhase = "discard"
	PhaseDraw     TurnPhase = "draw"
	PhasePostDraw TurnPhase = "postDraw"

	DrawSourceDeck    DrawSource = "deck"
	DrawSourceDiscard DrawSource = "discard"
)

type Card struct {
	ID    string `json:"id"`
	Rank  Rank   `json:"rank"`
	Suit  Suit   `json:"suit"`
	Value int    `json:"value"`
}

type Player struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	IsBot      bool   `json:"isBot"`
	Hand       []Card `json:"hand"`
	TotalScore int    `json:"totalScore"`
}

type SetupPlayerConfig struct {
	ID    string `json:"id,omitempty"`
	Name  string `json:"name"`
	IsBot bool   `json:"isBot"`
}

type DrawOffer struct {
	Card           Card   `json:"card"`
	FromPlayerID   string `json:"fromPlayerId"`
	FromPlayerName string `json:"fromPlayerName"`
	DiscardedCount int    `json:"discardedCount"`
}

type RoundScore struct {
	PlayerID       string `json:"playerId"`
	PlayerName     string `json:"playerName"`
	HandValue      int    `json:"handValue"`
	RoundPoints    int    `json:"roundPoints"`
	TotalScore     int    `json:"totalScore"`
	IsCaller       bool   `json:"isCaller"`
	PenaltyApplied bool   `json:"penaltyApplied"`
}

type RoundSummary struct {
	RoundNumber     int          `json:"roundNumber"`
	CallerID        string       `json:"callerId"`
	CallerName      string       `json:"callerName"`
	CallerHandValue int          `json:"callerHandValue"`
	LowestHandValue int          `json:"lowestHandValue"`
	CallerHadLowest bool         `json:"callerHadLowest"`
	Scores          []RoundScore `json:"scores"`
}

type GameState struct {
	Status             GameStatus    `json:"status"`
	Phase              TurnPhase     `json:"phase"`
	Players            []Player      `json:"players"`
	Deck               []Card        `json:"deck"`
	DiscardPile        []Card        `json:"discardPile"`
	DrawOffer          *DrawOffer    `json:"drawOffer"`
	PendingNextOffer   *DrawOffer    `json:"pendingNextOffer"`
	CurrentPlayerIndex int           `json:"currentPlayerIndex"`
	RoundNumber        int           `json:"roundNumber"`
	GameOverScore      int           `json:"gameOverScore"`
	RoundSummary       *RoundSummary `json:"roundSummary"`
	WinnerIDs          []string      `json:"winnerIds"`
	Message            string        `json:"message"`
}

type Action struct {
	Type          string              `json:"type"`
	Players       []SetupPlayerConfig `json:"players,omitempty"`
	GameOverScore int                 `json:"gameOverScore,omitempty"`
	CardIDs       []string            `json:"cardIds,omitempty"`
	Source        DrawSource          `json:"source,omitempty"`
}

type ShuffleFunc func([]Card) []Card

var suits = []Suit{SuitSpades, SuitHearts, SuitDiamonds, SuitClubs}
var ranks = []Rank{
	RankAce,
	RankTwo,
	RankThree,
	RankFour,
	RankFive,
	RankSix,
	RankSeven,
	RankEight,
	RankNine,
	RankTen,
	RankJack,
	RankQueen,
	RankKing,
}

var suitShortNames = map[Suit]string{
	SuitSpades:   "S",
	SuitHearts:   "H",
	SuitDiamonds: "D",
	SuitClubs:    "C",
}

var suitNames = map[Suit]string{
	SuitSpades:   "Spades",
	SuitHearts:   "Hearts",
	SuitDiamonds: "Diamonds",
	SuitClubs:    "Clubs",
}

var rankNames = map[Rank]string{
	RankAce:   "Ace",
	RankTwo:   "2",
	RankThree: "3",
	RankFour:  "4",
	RankFive:  "5",
	RankSix:   "6",
	RankSeven: "7",
	RankEight: "8",
	RankNine:  "9",
	RankTen:   "10",
	RankJack:  "Jack",
	RankQueen: "Queen",
	RankKing:  "King",
}

func InitialState() GameState {
	return GameState{
		Status:             StatusSetup,
		Phase:              PhaseDiscard,
		Players:            []Player{},
		Deck:               []Card{},
		DiscardPile:        []Card{},
		DrawOffer:          nil,
		PendingNextOffer:   nil,
		CurrentPlayerIndex: 0,
		RoundNumber:        0,
		GameOverScore:      GameOverScore,
		RoundSummary:       nil,
		WinnerIDs:          []string{},
		Message:            "Choose players to start Ganji.",
	}
}

func Reduce(state GameState, action Action) GameState {
	return ReduceWithShuffle(state, action, shuffle)
}

func ReduceWithShuffle(state GameState, action Action, shuffleFunc ShuffleFunc) GameState {
	switch action.Type {
	case "START_GAME":
		players := make([]Player, 0, min(len(action.Players), MaxPlayers))
		for index, setupPlayer := range action.Players {
			if index >= MaxPlayers {
				break
			}

			id := setupPlayer.ID
			if id == "" {
				id = fmt.Sprintf("player-%d", index+1)
			}

			players = append(players, Player{
				ID:         id,
				Name:       normalizePlayerName(setupPlayer.Name, index),
				IsBot:      setupPlayer.IsBot,
				Hand:       []Card{},
				TotalScore: 0,
			})
		}

		if len(players) < MinPlayers {
			return withMessage(state, fmt.Sprintf("Ganji needs at least %d players.", MinPlayers))
		}

		return startRound(players, 1, NormalizeGameOverScore(action.GameOverScore), shuffleFunc)

	case "DISCARD_CARDS":
		if state.Status != StatusPlaying || state.Phase != PhaseDiscard {
			return withMessage(state, "Discard cards at the start of your turn.")
		}

		currentPlayer := state.Players[state.CurrentPlayerIndex]
		selectedIDs := map[string]bool{}
		for _, cardID := range action.CardIDs {
			selectedIDs[cardID] = true
		}

		selectedCards := []Card{}
		for _, card := range currentPlayer.Hand {
			if selectedIDs[card.ID] {
				selectedCards = append(selectedCards, card)
			}
		}

		if len(selectedCards) == 0 {
			return withMessage(state, "Select at least one card to discard.")
		}

		if len(selectedCards) != len(selectedIDs) {
			return withMessage(state, "One or more selected cards are not in hand.")
		}

		if !CardsShareValue(selectedCards) {
			return withMessage(state, "Discarded cards must all have the same value.")
		}

		remainingHand := []Card{}
		for _, card := range currentPlayer.Hand {
			if !selectedIDs[card.ID] {
				remainingHand = append(remainingHand, card)
			}
		}

		latestDiscard := selectedCards[len(selectedCards)-1]
		buriedDiscards := selectedCards[:len(selectedCards)-1]
		players := replacePlayerHand(state.Players, state.CurrentPlayerIndex, remainingHand)
		discardPile := append(copyCards(state.DiscardPile), buriedDiscards...)

		state.Players = players
		state.Phase = PhaseDraw
		state.DiscardPile = discardPile
		state.PendingNextOffer = &DrawOffer{
			Card:           latestDiscard,
			FromPlayerID:   currentPlayer.ID,
			FromPlayerName: currentPlayer.Name,
			DiscardedCount: len(selectedCards),
		}
		state.Message = fmt.Sprintf(
			"%s discarded %s. Draw one card to finish the turn.",
			currentPlayer.Name,
			FormatCount(len(selectedCards), "card"),
		)
		return state

	case "DRAW_CARD":
		if state.Status != StatusPlaying || state.Phase != PhaseDraw {
			return withMessage(state, "Draw after discarding cards.")
		}

		if state.PendingNextOffer == nil {
			return withMessage(state, "Discard a card before drawing.")
		}

		currentPlayer := state.Players[state.CurrentPlayerIndex]
		deck := copyCards(state.Deck)
		discardPile := copyCards(state.DiscardPile)
		var drawnCard Card
		recycled := false

		if action.Source == DrawSourceDiscard {
			if state.DrawOffer == nil {
				return withMessage(state, "There is no previous discard to draw.")
			}

			drawnCard = state.DrawOffer.Card
		} else {
			drawResult := drawOneFromDeck(deck, discardPile, shuffleFunc)
			if drawResult.card == nil {
				return withMessage(state, "There are no cards available to draw.")
			}

			drawnCard = *drawResult.card
			deck = drawResult.deck
			discardPile = drawResult.discardPile
			if state.DrawOffer != nil {
				discardPile = append(discardPile, state.DrawOffer.Card)
			}
			recycled = drawResult.recycled
		}

		nextHand := append(copyCards(currentPlayer.Hand), drawnCard)
		players := replacePlayerHand(state.Players, state.CurrentPlayerIndex, nextHand)
		nextPlayerIndex := (state.CurrentPlayerIndex + 1) % len(state.Players)
		nextPlayer := players[nextPlayerIndex]
		sourceText := "drew from the deck"
		if action.Source == DrawSourceDiscard {
			sourceText = fmt.Sprintf("drew %s from %s's discard", CardName(drawnCard), state.DrawOffer.FromPlayerName)
		}
		recycleText := ""
		if recycled {
			recycleText = " The discard pile was shuffled into the deck."
		}

		state.Players = players
		state.Deck = deck
		state.DiscardPile = discardPile
		state.CurrentPlayerIndex = nextPlayerIndex
		state.DrawOffer = state.PendingNextOffer
		state.PendingNextOffer = nil
		state.Phase = PhaseDiscard
		state.Message = fmt.Sprintf("%s %s.%s %s's turn.", currentPlayer.Name, sourceText, recycleText, nextPlayer.Name)
		return state

	case "END_TURN":
		if state.Status != StatusPlaying || state.Phase != PhasePostDraw {
			return withMessage(state, "Finish your draw before ending the turn.")
		}

		if state.PendingNextOffer == nil {
			return withMessage(state, "Discard a card before ending the turn.")
		}

		nextPlayerIndex := (state.CurrentPlayerIndex + 1) % len(state.Players)
		nextPlayer := state.Players[nextPlayerIndex]
		state.Phase = PhaseDiscard
		state.CurrentPlayerIndex = nextPlayerIndex
		state.DrawOffer = state.PendingNextOffer
		state.PendingNextOffer = nil
		state.Message = fmt.Sprintf("%s's turn. Discard first, then draw one card.", nextPlayer.Name)
		return state

	case "CALL_GANJI":
		if state.Status != StatusPlaying {
			return withMessage(state, "Start a game before calling Ganji.")
		}

		if state.Phase != PhaseDiscard {
			return withMessage(state, "Ganji can only be called as the first action of your turn.")
		}

		currentPlayer := state.Players[state.CurrentPlayerIndex]
		handValue := CalculateHandValue(currentPlayer.Hand)
		if handValue > GanjiLimit {
			return withMessage(state, fmt.Sprintf("%s cannot call Ganji with %d points.", currentPlayer.Name, handValue))
		}

		return finishRound(state, currentPlayer)

	case "START_NEXT_ROUND":
		if state.Status != StatusRoundOver {
			return withMessage(state, "The current round is still in progress.")
		}

		return startRound(state.Players, state.RoundNumber+1, state.GameOverScore, shuffleFunc)

	case "RESET_GAME":
		return InitialState()
	}

	return state
}

func CalculateHandValue(hand []Card) int {
	sum := 0
	for _, card := range hand {
		sum += card.Value
	}
	return sum
}

func CardLabel(card Card) string {
	return string(card.Rank) + suitShortNames[card.Suit]
}

func CardName(card Card) string {
	return fmt.Sprintf("%s of %s", rankNames[card.Rank], suitNames[card.Suit])
}

func CardsShareValue(cards []Card) bool {
	if len(cards) == 0 {
		return true
	}

	value := cards[0].Value
	for _, card := range cards {
		if card.Value != value {
			return false
		}
	}
	return true
}

func CanDrawFromDeck(state GameState) bool {
	if state.Status != StatusPlaying || state.Phase != PhaseDraw {
		return false
	}

	return len(state.Deck) > 0 || len(state.DiscardPile) > 0
}

func ChooseBotDiscard(hand []Card) []Card {
	groups := map[int][]Card{}
	valueOrder := []int{}
	for _, card := range hand {
		if _, exists := groups[card.Value]; !exists {
			valueOrder = append(valueOrder, card.Value)
		}
		groups[card.Value] = append(groups[card.Value], card)
	}

	bestCards := []Card{}
	bestScore := math.MinInt
	for _, value := range valueOrder {
		cards := groups[value]
		discardScore := cards[0].Value * len(cards)
		isBetterScore := discardScore > bestScore
		isBetterTie := discardScore == bestScore && len(cards) > len(bestCards)
		if isBetterScore || isBetterTie {
			bestCards = cards
			bestScore = discardScore
		}
	}

	return copyCards(bestCards)
}

func ChooseBotDrawSource(state GameState) DrawSource {
	if state.DrawOffer == nil {
		return DrawSourceDeck
	}

	hasIndependentDeck := len(state.Deck) > 0 || len(state.DiscardPile) > 0
	if !hasIndependentDeck {
		return DrawSourceDiscard
	}

	currentPlayer := state.Players[state.CurrentPlayerIndex]
	projectedValue := CalculateHandValue(currentPlayer.Hand) + state.DrawOffer.Card.Value
	if state.DrawOffer.Card.Value <= 4 || projectedValue <= GanjiLimit {
		return DrawSourceDiscard
	}

	return DrawSourceDeck
}

func FormatCount(count int, singular string) string {
	suffix := "s"
	if count == 1 {
		suffix = ""
	}
	return fmt.Sprintf("%d %s%s", count, singular, suffix)
}

func NormalizeGameOverScore(score int) int {
	for _, option := range GameOverScoreOptions {
		if score == option {
			return score
		}
	}

	return GameOverScore
}

func startRound(players []Player, roundNumber int, gameOverScore int, shuffleFunc ShuffleFunc) GameState {
	deck := shuffleFunc(createDeck())
	roundPlayers := make([]Player, len(players))
	for index, player := range players {
		roundPlayers[index] = player
		roundPlayers[index].Hand = []Card{}
	}

	for cardIndex := 0; cardIndex < 4; cardIndex++ {
		for playerIndex := range roundPlayers {
			if len(deck) == 0 {
				break
			}

			roundPlayers[playerIndex].Hand = append(roundPlayers[playerIndex].Hand, deck[0])
			deck = deck[1:]
		}
	}

	currentPlayerIndex := (roundNumber - 1) % len(roundPlayers)
	startingPlayer := roundPlayers[currentPlayerIndex]

	return GameState{
		Status:             StatusPlaying,
		Phase:              PhaseDiscard,
		Players:            roundPlayers,
		Deck:               deck,
		DiscardPile:        []Card{},
		DrawOffer:          nil,
		PendingNextOffer:   nil,
		CurrentPlayerIndex: currentPlayerIndex,
		RoundNumber:        roundNumber,
		GameOverScore:      gameOverScore,
		RoundSummary:       nil,
		WinnerIDs:          []string{},
		Message:            fmt.Sprintf("Round %d started. %s takes the first turn.", roundNumber, startingPlayer.Name),
	}
}

func finishRound(state GameState, caller Player) GameState {
	handValues := map[string]int{}
	lowestHandValue := math.MaxInt
	for _, player := range state.Players {
		handValue := CalculateHandValue(player.Hand)
		handValues[player.ID] = handValue
		if handValue < lowestHandValue {
			lowestHandValue = handValue
		}
	}

	callerHandValue := handValues[caller.ID]
	callerHadLowest := callerHandValue == lowestHandValue
	roundScores := make([]RoundScore, 0, len(state.Players))
	for _, player := range state.Players {
		handValue := handValues[player.ID]
		isCaller := player.ID == caller.ID
		penaltyApplied := isCaller && !callerHadLowest
		roundPoints := handValue
		if isCaller {
			if callerHadLowest {
				roundPoints = 0
			} else {
				roundPoints = handValue + 25
			}
		}

		roundScores = append(roundScores, RoundScore{
			PlayerID:       player.ID,
			PlayerName:     player.Name,
			HandValue:      handValue,
			RoundPoints:    roundPoints,
			TotalScore:     player.TotalScore + roundPoints,
			IsCaller:       isCaller,
			PenaltyApplied: penaltyApplied,
		})
	}

	players := make([]Player, len(state.Players))
	for playerIndex, player := range state.Players {
		players[playerIndex] = player
		for _, roundScore := range roundScores {
			if roundScore.PlayerID == player.ID {
				players[playerIndex].TotalScore = roundScore.TotalScore
				break
			}
		}
	}

	gameOver := false
	lowestTotal := math.MaxInt
	for _, player := range players {
		if player.TotalScore >= state.GameOverScore {
			gameOver = true
		}
		if player.TotalScore < lowestTotal {
			lowestTotal = player.TotalScore
		}
	}

	winnerIDs := []string{}
	if gameOver {
		for _, player := range players {
			if player.TotalScore == lowestTotal {
				winnerIDs = append(winnerIDs, player.ID)
			}
		}
	}

	status := StatusRoundOver
	if gameOver {
		status = StatusGameOver
	}

	resultText := fmt.Sprintf("%s called Ganji successfully.", caller.Name)
	if !callerHadLowest {
		resultText = fmt.Sprintf("%s missed Ganji and took a 25 point penalty.", caller.Name)
	}

	state.Status = status
	state.Phase = PhaseDiscard
	state.Players = players
	state.DrawOffer = nil
	state.PendingNextOffer = nil
	state.RoundSummary = &RoundSummary{
		RoundNumber:     state.RoundNumber,
		CallerID:        caller.ID,
		CallerName:      caller.Name,
		CallerHandValue: callerHandValue,
		LowestHandValue: lowestHandValue,
		CallerHadLowest: callerHadLowest,
		Scores:          roundScores,
	}
	state.WinnerIDs = winnerIDs
	state.Message = resultText
	return state
}

func createDeck() []Card {
	deck := make([]Card, 0, len(suits)*len(ranks))
	for _, suit := range suits {
		for _, rank := range ranks {
			deck = append(deck, Card{
				ID:    fmt.Sprintf("%s-%s", rank, suit),
				Rank:  rank,
				Suit:  suit,
				Value: cardValue(rank, suit),
			})
		}
	}
	return deck
}

func cardValue(rank Rank, suit Suit) int {
	if rank == RankKing && (suit == SuitSpades || suit == SuitClubs) {
		return 0
	}

	if rank == RankAce {
		return 1
	}

	if rank == RankJack {
		return 11
	}

	if rank == RankQueen {
		return 12
	}

	if rank == RankKing {
		return 13
	}

	return atoiRank(rank)
}

func atoiRank(rank Rank) int {
	switch rank {
	case RankTwo:
		return 2
	case RankThree:
		return 3
	case RankFour:
		return 4
	case RankFive:
		return 5
	case RankSix:
		return 6
	case RankSeven:
		return 7
	case RankEight:
		return 8
	case RankNine:
		return 9
	case RankTen:
		return 10
	default:
		return 0
	}
}

func shuffle(items []Card) []Card {
	shuffled := copyCards(items)
	rand.Shuffle(len(shuffled), func(firstIndex, secondIndex int) {
		shuffled[firstIndex], shuffled[secondIndex] = shuffled[secondIndex], shuffled[firstIndex]
	})
	return shuffled
}

type drawResult struct {
	card        *Card
	deck        []Card
	discardPile []Card
	recycled    bool
}

func drawOneFromDeck(deck []Card, discardPile []Card, shuffleFunc ShuffleFunc) drawResult {
	nextDeck := copyCards(deck)
	nextDiscardPile := copyCards(discardPile)
	recycled := false

	if len(nextDeck) == 0 && len(nextDiscardPile) > 0 {
		nextDeck = shuffleFunc(nextDiscardPile)
		nextDiscardPile = []Card{}
		recycled = true
	}

	if len(nextDeck) == 0 {
		return drawResult{card: nil, deck: nextDeck, discardPile: nextDiscardPile, recycled: recycled}
	}

	card := nextDeck[0]
	return drawResult{
		card:        &card,
		deck:        nextDeck[1:],
		discardPile: nextDiscardPile,
		recycled:    recycled,
	}
}

func replacePlayerHand(players []Player, playerIndex int, hand []Card) []Player {
	nextPlayers := make([]Player, len(players))
	copy(nextPlayers, players)
	nextPlayers[playerIndex].Hand = copyCards(hand)
	return nextPlayers
}

func normalizePlayerName(name string, index int) string {
	trimmedName := strings.TrimSpace(name)
	if trimmedName != "" {
		return trimmedName
	}
	return fmt.Sprintf("Player %d", index+1)
}

func withMessage(state GameState, message string) GameState {
	state.Message = message
	return state
}

func copyCards(cards []Card) []Card {
	if cards == nil {
		return nil
	}

	copied := make([]Card, len(cards))
	copy(copied, cards)
	return copied
}

func SortedCardIDs(cards []Card) []string {
	cardIDs := make([]string, len(cards))
	for index, card := range cards {
		cardIDs[index] = card.ID
	}
	sort.Strings(cardIDs)
	return cardIDs
}
