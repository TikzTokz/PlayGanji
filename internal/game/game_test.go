package game

import "testing"

func identityShuffle(cards []Card) []Card {
	copied := make([]Card, len(cards))
	copy(copied, cards)
	return copied
}

func testCard(id string, rank Rank, suit Suit, value int) Card {
	return Card{ID: id, Rank: rank, Suit: suit, Value: value}
}

func TestStartGameRequiresMinimumPlayers(t *testing.T) {
	state := ReduceWithShuffle(InitialState(), Action{
		Type: "START_GAME",
		Players: []SetupPlayerConfig{
			{Name: "A"},
			{Name: "B"},
		},
	}, identityShuffle)

	if state.Status != StatusSetup {
		t.Fatalf("status = %q, want setup", state.Status)
	}
	if state.Message != "Ganji needs at least 3 players." {
		t.Fatalf("message = %q", state.Message)
	}
}

func TestStartGameDealsFourCardsEach(t *testing.T) {
	state := ReduceWithShuffle(InitialState(), Action{
		Type: "START_GAME",
		Players: []SetupPlayerConfig{
			{ID: "p1", Name: "A"},
			{ID: "p2", Name: "B"},
			{ID: "p3", Name: "C"},
		},
		GameOverScore: 50,
	}, identityShuffle)

	if state.Status != StatusPlaying {
		t.Fatalf("status = %q, want playing", state.Status)
	}
	if state.GameOverScore != 50 {
		t.Fatalf("gameOverScore = %d, want 50", state.GameOverScore)
	}
	if len(state.Deck) != 40 {
		t.Fatalf("deck length = %d, want 40", len(state.Deck))
	}
	for _, player := range state.Players {
		if len(player.Hand) != 4 {
			t.Fatalf("%s hand length = %d, want 4", player.ID, len(player.Hand))
		}
	}
}

func TestDiscardValidationAndValidDiscard(t *testing.T) {
	fiveHearts := testCard("5-hearts", RankFive, SuitHearts, 5)
	fiveClubs := testCard("5-clubs", RankFive, SuitClubs, 5)
	aceSpades := testCard("A-spades", RankAce, SuitSpades, 1)
	state := GameState{
		Status:             StatusPlaying,
		Phase:              PhaseDiscard,
		Players:            []Player{{ID: "p1", Name: "A", Hand: []Card{fiveHearts, fiveClubs, aceSpades}}, {ID: "p2", Name: "B"}, {ID: "p3", Name: "C"}},
		CurrentPlayerIndex: 0,
		RoundNumber:        1,
		GameOverScore:      100,
	}

	noCards := ReduceWithShuffle(state, Action{Type: "DISCARD_CARDS"}, identityShuffle)
	if noCards.Message != "Select at least one card to discard." {
		t.Fatalf("message = %q", noCards.Message)
	}

	mixedValues := ReduceWithShuffle(state, Action{Type: "DISCARD_CARDS", CardIDs: []string{fiveHearts.ID, aceSpades.ID}}, identityShuffle)
	if mixedValues.Message != "Discarded cards must all have the same value." {
		t.Fatalf("message = %q", mixedValues.Message)
	}

	next := ReduceWithShuffle(state, Action{Type: "DISCARD_CARDS", CardIDs: []string{fiveHearts.ID, fiveClubs.ID}}, identityShuffle)
	if next.Phase != PhaseDraw {
		t.Fatalf("phase = %q, want draw", next.Phase)
	}
	if len(next.Players[0].Hand) != 1 || next.Players[0].Hand[0].ID != aceSpades.ID {
		t.Fatalf("remaining hand = %#v", next.Players[0].Hand)
	}
	if next.PendingNextOffer == nil || next.PendingNextOffer.Card.ID != fiveClubs.ID || next.PendingNextOffer.DiscardedCount != 2 {
		t.Fatalf("pending offer = %#v", next.PendingNextOffer)
	}
	if len(next.DiscardPile) != 1 || next.DiscardPile[0].ID != fiveHearts.ID {
		t.Fatalf("discard pile = %#v", next.DiscardPile)
	}
}

func TestDrawFromDiscardAdvancesTurn(t *testing.T) {
	discarded := testCard("7-clubs", RankSeven, SuitClubs, 7)
	offer := testCard("A-spades", RankAce, SuitSpades, 1)
	state := GameState{
		Status:             StatusPlaying,
		Phase:              PhaseDraw,
		Players:            []Player{{ID: "p1", Name: "A", Hand: []Card{}}, {ID: "p2", Name: "B"}, {ID: "p3", Name: "C"}},
		Deck:               []Card{testCard("2-hearts", RankTwo, SuitHearts, 2)},
		DrawOffer:          &DrawOffer{Card: offer, FromPlayerID: "p3", FromPlayerName: "C", DiscardedCount: 1},
		PendingNextOffer:   &DrawOffer{Card: discarded, FromPlayerID: "p1", FromPlayerName: "A", DiscardedCount: 1},
		CurrentPlayerIndex: 0,
		RoundNumber:        1,
		GameOverScore:      100,
	}

	next := ReduceWithShuffle(state, Action{Type: "DRAW_CARD", Source: DrawSourceDiscard}, identityShuffle)
	if next.CurrentPlayerIndex != 1 {
		t.Fatalf("currentPlayerIndex = %d, want 1", next.CurrentPlayerIndex)
	}
	if next.Phase != PhaseDiscard {
		t.Fatalf("phase = %q, want discard", next.Phase)
	}
	if len(next.Players[0].Hand) != 1 || next.Players[0].Hand[0].ID != offer.ID {
		t.Fatalf("hand = %#v", next.Players[0].Hand)
	}
	if next.DrawOffer == nil || next.DrawOffer.Card.ID != discarded.ID {
		t.Fatalf("draw offer = %#v", next.DrawOffer)
	}
}

func TestCallGanjiRestrictionsAndSuccessfulScoring(t *testing.T) {
	callerCard := testCard("4-hearts", RankFour, SuitHearts, 4)
	state := GameState{
		Status:             StatusPlaying,
		Phase:              PhaseDiscard,
		Players:            []Player{{ID: "p1", Name: "A", Hand: []Card{callerCard}}, {ID: "p2", Name: "B", Hand: []Card{testCard("8-clubs", RankEight, SuitClubs, 8)}}, {ID: "p3", Name: "C", Hand: []Card{testCard("9-hearts", RankNine, SuitHearts, 9)}}},
		CurrentPlayerIndex: 0,
		RoundNumber:        1,
		GameOverScore:      100,
	}
	highHandState := state
	highHandState.Players = make([]Player, len(state.Players))
	copy(highHandState.Players, state.Players)
	highHandState.Players[0].Hand = []Card{testCard("6-hearts", RankSix, SuitHearts, 6)}
	highHand := ReduceWithShuffle(highHandState, Action{Type: "CALL_GANJI"}, identityShuffle)
	if highHand.Status != StatusPlaying || highHand.Message != "A cannot call Ganji with 6 points." {
		t.Fatalf("high hand status/message = %q/%q", highHand.Status, highHand.Message)
	}

	next := ReduceWithShuffle(state, Action{Type: "CALL_GANJI"}, identityShuffle)
	if next.Status != StatusRoundOver {
		t.Fatalf("status = %q, want roundOver", next.Status)
	}
	if next.RoundSummary == nil || !next.RoundSummary.CallerHadLowest {
		t.Fatalf("round summary = %#v", next.RoundSummary)
	}
	if next.Players[0].TotalScore != 0 || next.Players[1].TotalScore != 8 || next.Players[2].TotalScore != 9 {
		t.Fatalf("scores = %#v", next.Players)
	}
}

func TestMissedGanjiAppliesPenaltyAndGameOverWinners(t *testing.T) {
	state := GameState{
		Status:             StatusPlaying,
		Phase:              PhaseDiscard,
		Players:            []Player{{ID: "p1", Name: "A", Hand: []Card{testCard("5-hearts", RankFive, SuitHearts, 5)}, TotalScore: 20}, {ID: "p2", Name: "B", Hand: []Card{testCard("A-spades", RankAce, SuitSpades, 1)}, TotalScore: 10}, {ID: "p3", Name: "C", Hand: []Card{testCard("2-clubs", RankTwo, SuitClubs, 2)}, TotalScore: 15}},
		CurrentPlayerIndex: 0,
		RoundNumber:        1,
		GameOverScore:      50,
	}

	next := ReduceWithShuffle(state, Action{Type: "CALL_GANJI"}, identityShuffle)
	if next.Status != StatusGameOver {
		t.Fatalf("status = %q, want gameOver", next.Status)
	}
	if next.RoundSummary == nil || next.RoundSummary.CallerHadLowest || !next.RoundSummary.Scores[0].PenaltyApplied {
		t.Fatalf("round summary = %#v", next.RoundSummary)
	}
	if next.Players[0].TotalScore != 50 {
		t.Fatalf("caller total = %d, want 50", next.Players[0].TotalScore)
	}
	if len(next.WinnerIDs) != 1 || next.WinnerIDs[0] != "p2" {
		t.Fatalf("winnerIds = %#v", next.WinnerIDs)
	}
}

func TestBotChoices(t *testing.T) {
	fives := []Card{testCard("5-hearts", RankFive, SuitHearts, 5), testCard("5-clubs", RankFive, SuitClubs, 5)}
	hand := append([]Card{testCard("K-spades", RankKing, SuitSpades, 0)}, fives...)
	discard := ChooseBotDiscard(hand)
	if len(discard) != 2 || discard[0].ID != fives[0].ID || discard[1].ID != fives[1].ID {
		t.Fatalf("discard = %#v", discard)
	}

	state := GameState{
		Players:            []Player{{ID: "p1", Hand: []Card{testCard("A-hearts", RankAce, SuitHearts, 1)}}},
		CurrentPlayerIndex: 0,
		Deck:               []Card{testCard("9-spades", RankNine, SuitSpades, 9)},
		DrawOffer:          &DrawOffer{Card: testCard("4-diamonds", RankFour, SuitDiamonds, 4)},
	}
	if source := ChooseBotDrawSource(state); source != DrawSourceDiscard {
		t.Fatalf("source = %q, want discard", source)
	}

	state.DrawOffer.Card = testCard("9-diamonds", RankNine, SuitDiamonds, 9)
	if source := ChooseBotDrawSource(state); source != DrawSourceDeck {
		t.Fatalf("source = %q, want deck", source)
	}
}
