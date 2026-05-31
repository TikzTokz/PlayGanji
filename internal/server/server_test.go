package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHealthEndpoint(t *testing.T) {
	ganjiServer := New("dist")
	testServer := httptest.NewServer(ganjiServer.Handler())
	defer testServer.Close()

	response, err := http.Get(testServer.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	var body struct {
		OK    bool `json:"ok"`
		Rooms int  `json:"rooms"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Rooms != 0 {
		t.Fatalf("body = %#v", body)
	}
}

func TestCreateJoinAndRejoinRoom(t *testing.T) {
	ganjiServer, wsURL, cleanup := newTestWSServer(t)
	defer cleanup()

	host := dialWS(t, wsURL)
	defer host.Close()
	sendWS(t, host, map[string]any{"type": "CREATE_ROOM", "name": "Host", "turnTimerSeconds": 60, "gameOverScore": 100})
	hostUpdate := readUntil(t, host, "ROOM_UPDATE")
	roomCode := hostUpdate.Room.RoomCode
	sessionID := hostUpdate.SessionID

	guest := dialWS(t, wsURL)
	defer guest.Close()
	sendWS(t, guest, map[string]any{"type": "JOIN_ROOM", "roomCode": roomCode, "name": "Guest"})
	guestUpdate := readUntil(t, guest, "ROOM_UPDATE")
	if guestUpdate.Room.ViewerPlayerID != "player-2" {
		t.Fatalf("guest viewer = %q, want player-2", guestUpdate.Room.ViewerPlayerID)
	}
	if len(guestUpdate.Room.Players) != 2 {
		t.Fatalf("players = %d, want 2", len(guestUpdate.Room.Players))
	}

	room := ganjiServer.getRoom(roomCode)
	if room == nil {
		t.Fatal("room was not stored")
	}
	room.mu.Lock()
	room.Players[0].Connected = false
	room.Players[0].SubstituteActive = true
	room.mu.Unlock()

	rejoin := dialWS(t, wsURL)
	defer rejoin.Close()
	sendWS(t, rejoin, map[string]any{"type": "REJOIN_ROOM", "roomCode": roomCode, "sessionId": sessionID})
	rejoinUpdate := readUntil(t, rejoin, "ROOM_UPDATE")
	if rejoinUpdate.Room.ViewerPlayerID != "player-1" {
		t.Fatalf("rejoin viewer = %q, want player-1", rejoinUpdate.Room.ViewerPlayerID)
	}
	if !rejoinUpdate.Room.Players[0].Connected || rejoinUpdate.Room.Players[0].SubstituteActive {
		t.Fatalf("rejoined player = %#v", rejoinUpdate.Room.Players[0])
	}
}

func TestInvalidRejoinReturnsError(t *testing.T) {
	_, wsURL, cleanup := newTestWSServer(t)
	defer cleanup()

	client := dialWS(t, wsURL)
	defer client.Close()
	sendWS(t, client, map[string]any{"type": "REJOIN_ROOM", "roomCode": "ABC123", "sessionId": "missing"})

	message := readUntil(t, client, "ERROR")
	if message.Message != "Room not found." {
		t.Fatalf("message = %q", message.Message)
	}
}

func TestReconnectCheckValidatesSavedSession(t *testing.T) {
	ganjiServer := New("dist")
	testServer := httptest.NewServer(ganjiServer.Handler())
	defer testServer.Close()
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/ws"

	host := dialWS(t, wsURL)
	defer host.Close()
	sendWS(t, host, map[string]any{"type": "CREATE_ROOM", "name": "Host", "turnTimerSeconds": 60, "gameOverScore": 100})
	hostUpdate := readUntil(t, host, "ROOM_UPDATE")

	valid := postReconnectCheck(t, testServer.URL, hostUpdate.Room.RoomCode, hostUpdate.SessionID)
	if !valid.CanReconnect {
		t.Fatal("expected valid saved session to reconnect")
	}

	invalidSession := postReconnectCheck(t, testServer.URL, hostUpdate.Room.RoomCode, "missing-session")
	if invalidSession.CanReconnect {
		t.Fatal("expected invalid session to be rejected")
	}

	missingRoom := postReconnectCheck(t, testServer.URL, "ABC123", hostUpdate.SessionID)
	if missingRoom.CanReconnect {
		t.Fatal("expected missing room to be rejected")
	}
}

func TestHostOnlyActionsAreRejectedForGuests(t *testing.T) {
	_, _, guest, cleanup := createHostGuestRoom(t)
	defer cleanup()

	sendWS(t, guest, map[string]any{"type": "ADD_BOT"})
	message := readUntil(t, guest, "ERROR")
	if message.Message != "Only the host can add bots." {
		t.Fatalf("message = %q", message.Message)
	}
}

func TestOutOfTurnActionIsRejectedAndHandsAreRedacted(t *testing.T) {
	host, _, guest, cleanup := createHostGuestRoom(t)
	defer cleanup()

	sendWS(t, guest, map[string]any{"type": "SET_READY", "ready": true})
	_ = readUntil(t, guest, "ROOM_UPDATE")

	sendWS(t, host, map[string]any{"type": "ADD_BOT"})
	_ = readUntil(t, host, "ROOM_UPDATE")

	sendWS(t, host, map[string]any{"type": "START_GAME"})
	hostUpdate := readUntilPlaying(t, host)
	guestUpdate := readUntilPlaying(t, guest)

	if hostUpdate.Room.GameState == nil || guestUpdate.Room.GameState == nil {
		t.Fatal("missing game state")
	}
	if hostUpdate.Room.GameState.Players[0].Hand[0].ID == guestUpdate.Room.GameState.Players[0].Hand[0].ID {
		t.Fatalf("guest can see host hand: %#v", guestUpdate.Room.GameState.Players[0].Hand)
	}
	if !strings.HasPrefix(guestUpdate.Room.GameState.Players[0].Hand[0].ID, "hidden-player-1-") {
		t.Fatalf("host hand was not hidden from guest: %#v", guestUpdate.Room.GameState.Players[0].Hand)
	}
	if strings.HasPrefix(guestUpdate.Room.GameState.Players[1].Hand[0].ID, "hidden-") {
		t.Fatalf("guest own hand was hidden: %#v", guestUpdate.Room.GameState.Players[1].Hand)
	}

	sendWS(t, guest, map[string]any{"type": "CALL_GANJI"})
	message := readUntil(t, guest, "ERROR")
	if message.Message != "It is Host's turn." {
		t.Fatalf("message = %q", message.Message)
	}
}

func createHostGuestRoom(t *testing.T) (*websocket.Conn, string, *websocket.Conn, func()) {
	t.Helper()
	_, wsURL, cleanup := newTestWSServer(t)

	host := dialWS(t, wsURL)
	sendWS(t, host, map[string]any{"type": "CREATE_ROOM", "name": "Host", "turnTimerSeconds": 60, "gameOverScore": 100})
	hostUpdate := readUntil(t, host, "ROOM_UPDATE")

	guest := dialWS(t, wsURL)
	sendWS(t, guest, map[string]any{"type": "JOIN_ROOM", "roomCode": hostUpdate.Room.RoomCode, "name": "Guest"})
	_ = readUntil(t, guest, "ROOM_UPDATE")

	return host, hostUpdate.Room.RoomCode, guest, func() {
		host.Close()
		guest.Close()
		cleanup()
	}
}

func newTestWSServer(t *testing.T) (*Server, string, func()) {
	t.Helper()
	ganjiServer := New("dist")
	testServer := httptest.NewServer(ganjiServer.Handler())
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/ws"
	return ganjiServer, wsURL, testServer.Close
}

func dialWS(t *testing.T, wsURL string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn
}

func sendWS(t *testing.T, conn *websocket.Conn, message any) {
	t.Helper()
	if err := conn.WriteJSON(message); err != nil {
		t.Fatal(err)
	}
}

func postReconnectCheck(t *testing.T, serverURL string, roomCode string, sessionID string) reconnectCheckResponse {
	t.Helper()
	body, err := json.Marshal(reconnectCheckRequest{RoomCode: roomCode, SessionID: sessionID})
	if err != nil {
		t.Fatal(err)
	}

	response, err := http.Post(serverURL+"/api/reconnect-check", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}

	var checkResponse reconnectCheckResponse
	if err := json.NewDecoder(response.Body).Decode(&checkResponse); err != nil {
		t.Fatal(err)
	}
	return checkResponse
}

func readUntil(t *testing.T, conn *websocket.Conn, messageType string) serverMessage {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond)); err != nil {
			t.Fatal(err)
		}

		var message serverMessage
		if err := conn.ReadJSON(&message); err != nil {
			continue
		}
		if message.Type == "ERROR" && message.Message == "Connected. Create or join a room." {
			continue
		}
		if message.Type == messageType {
			return message
		}
	}
	t.Fatalf("timed out waiting for %s", messageType)
	return serverMessage{}
}

func readUntilPlaying(t *testing.T, conn *websocket.Conn) serverMessage {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		message := readUntil(t, conn, "ROOM_UPDATE")
		if message.Room != nil && message.Room.GameState != nil && message.Room.GameState.Status == "playing" {
			return message
		}
	}
	t.Fatal("timed out waiting for playing room update")
	return serverMessage{}
}
