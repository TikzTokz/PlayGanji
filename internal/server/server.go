package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"playganji/internal/game"
)

const (
	inactiveRoomTimeout    = 15 * time.Minute
	maxReconnectBodyBytes  = 4 * 1024
	maxWebSocketMessage    = 16 * 1024
	webSocketPongWait      = 60 * time.Second
	webSocketPingPeriod    = (webSocketPongWait * 9) / 10
	webSocketWriteWait     = 10 * time.Second
	maxPlayerNameRuneCount = 24
)

type Server struct {
	mu       sync.RWMutex
	rooms    map[string]*Room
	distDir  string
	upgrader websocket.Upgrader
}

type Client struct {
	mu        sync.Mutex
	conn      *websocket.Conn
	send      chan []byte
	socketID  string
	roomCode  string
	playerID  string
	sessionID string
	closed    bool
}

type ServerPlayer struct {
	ID                      string
	Name                    string
	IsBot                   bool
	Connected               bool
	Ready                   bool
	SubstituteActive        bool
	SessionID               string
	DisconnectedTimeoutUsed bool
}

type Room struct {
	mu                   sync.Mutex
	server               *Server
	RoomCode             string
	HostPlayerID         string
	Players              []ServerPlayer
	GameState            *game.GameState
	Sockets              map[string]*Client
	NextPlayerNumber     int
	NextBotNumber        int
	BotTimer             *time.Timer
	TurnTimer            *time.Timer
	InactiveCleanupTimer *time.Timer
	TurnTimerSeconds     int
	GameOverScore        int
	TurnDeadline         *int64
	TurnTimerKey         string
	TurnTimerGeneration  int64
	Message              string
}

type clientMessage struct {
	Type             string          `json:"type"`
	Name             string          `json:"name"`
	RoomCode         string          `json:"roomCode"`
	SessionID        string          `json:"sessionId"`
	TurnTimerSeconds int             `json:"turnTimerSeconds"`
	GameOverScore    int             `json:"gameOverScore"`
	PlayerID         string          `json:"playerId"`
	Ready            bool            `json:"ready"`
	CardIDs          []string        `json:"cardIds"`
	Source           game.DrawSource `json:"source"`
}

type serverMessage struct {
	Type      string    `json:"type"`
	Code      string    `json:"code,omitempty"`
	Message   string    `json:"message,omitempty"`
	Room      *RoomView `json:"room,omitempty"`
	SessionID string    `json:"sessionId,omitempty"`
	RoomCode  string    `json:"roomCode,omitempty"`
}

type reconnectCheckRequest struct {
	RoomCode  string `json:"roomCode"`
	SessionID string `json:"sessionId"`
}

type reconnectCheckResponse struct {
	CanReconnect bool `json:"canReconnect"`
}

type OnlineLobbyPlayer struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	IsBot            bool   `json:"isBot"`
	Connected        bool   `json:"connected"`
	Ready            bool   `json:"ready"`
	SubstituteActive bool   `json:"substituteActive"`
}

type RoomView struct {
	RoomCode         string              `json:"roomCode"`
	Status           string              `json:"status"`
	Players          []OnlineLobbyPlayer `json:"players"`
	GameState        *game.GameState     `json:"gameState"`
	ViewerPlayerID   string              `json:"viewerPlayerId"`
	HostPlayerID     string              `json:"hostPlayerId"`
	TurnTimerSeconds int                 `json:"turnTimerSeconds"`
	GameOverScore    int                 `json:"gameOverScore"`
	TurnDeadline     *int64              `json:"turnDeadline"`
	Message          string              `json:"message"`
}

func New(distDir string) *Server {
	return &Server{
		rooms:   map[string]*Room{},
		distDir: distDir,
		upgrader: websocket.Upgrader{
			CheckOrigin: isAllowedWebSocketOrigin,
		},
	}
}

func isAllowedWebSocketOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}

	originURL, err := url.Parse(origin)
	if err != nil || originURL.Host == "" {
		return false
	}

	requestHost := hostWithoutPort(r.Host)
	originHost := hostWithoutPort(originURL.Host)
	if strings.EqualFold(originURL.Host, r.Host) || (isLoopbackHost(requestHost) && isLoopbackHost(originHost)) {
		return true
	}

	for _, allowedOrigin := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		allowedOrigin = strings.TrimRight(strings.TrimSpace(allowedOrigin), "/")
		if allowedOrigin != "" && strings.EqualFold(allowedOrigin, strings.TrimRight(origin, "/")) {
			return true
		}
	}

	return false
}

func hostWithoutPort(host string) string {
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		return parsedHost
	}
	return strings.Trim(host, "[]")
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(host)
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/api/reconnect-check", s.handleReconnectCheck)
	mux.HandleFunc("/ws", s.handleWebSocket)
	mux.HandleFunc("/", s.handleStatic)
	return mux
}

func (s *Server) ListenAndServe(addr string) error {
	httpServer := &http.Server{
		Addr:              addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return httpServer.ListenAndServe()
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	roomCount := len(s.rooms)
	s.mu.RUnlock()

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "rooms": roomCount})
}

func (s *Server) handleReconnectCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	var request reconnectCheckRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxReconnectBodyBytes)
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "Invalid request body.", http.StatusBadRequest)
		return
	}

	canReconnect := false
	room := s.getRoom(strings.ToUpper(strings.TrimSpace(request.RoomCode)))
	if room != nil {
		room.mu.Lock()
		for _, player := range room.Players {
			if player.SessionID != "" && player.SessionID == request.SessionID {
				canReconnect = true
				break
			}
		}
		room.mu.Unlock()
	}

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(reconnectCheckResponse{CanReconnect: canReconnect})
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	client := &Client{
		conn:     conn,
		send:     make(chan []byte, 32),
		socketID: createID(),
	}

	go client.writePump()
	client.sendJSON(serverMessage{Type: "ERROR", Message: "Connected. Create or join a room."})
	s.readPump(client)
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	cleanPath := filepath.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
	if strings.Contains(cleanPath, "..") {
		http.NotFound(w, r)
		return
	}

	filePath := filepath.Join(s.distDir, cleanPath)
	if cleanPath == "/" {
		filePath = filepath.Join(s.distDir, "index.html")
	}

	if stat, err := os.Stat(filePath); err == nil && !stat.IsDir() {
		http.ServeFile(w, r, filePath)
		return
	}

	fallbackPath := filepath.Join(s.distDir, "index.html")
	if stat, err := os.Stat(fallbackPath); err == nil && !stat.IsDir() {
		http.ServeFile(w, r, fallbackPath)
		return
	}

	w.Header().Set("content-type", "text/plain")
	_, _ = w.Write([]byte("Ganji multiplayer server is running. Build the client with `bun run build` to serve it here."))
}

func (s *Server) readPump(client *Client) {
	defer func() {
		s.detachClient(client)
		client.close()
	}()
	client.conn.SetReadLimit(maxWebSocketMessage)
	_ = client.conn.SetReadDeadline(time.Now().Add(webSocketPongWait))
	client.conn.SetPongHandler(func(string) error {
		return client.conn.SetReadDeadline(time.Now().Add(webSocketPongWait))
	})

	for {
		_, rawMessage, err := client.conn.ReadMessage()
		if err != nil {
			return
		}

		s.handleClientMessage(client, rawMessage)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(webSocketPingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(webSocketWriteWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(webSocketWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendJSON(value any) {
	message, err := json.Marshal(value)
	if err != nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}

	select {
	case c.send <- message:
	default:
	}
}

func (c *Client) close() {
	c.mu.Lock()
	if !c.closed {
		c.closed = true
		close(c.send)
	}
	c.mu.Unlock()
	_ = c.conn.Close()
}

func (c *Client) data() (roomCode string, playerID string, sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.roomCode, c.playerID, c.sessionID
}

func (c *Client) setData(roomCode string, playerID string, sessionID string) {
	c.mu.Lock()
	c.roomCode = roomCode
	c.playerID = playerID
	c.sessionID = sessionID
	c.mu.Unlock()
}

func (c *Client) clearData() {
	c.setData("", "", "")
}

func (s *Server) handleClientMessage(client *Client, rawMessage []byte) {
	var message clientMessage
	if err := json.Unmarshal(rawMessage, &message); err != nil {
		sendError(client, "Invalid message format.")
		return
	}

	switch message.Type {
	case "CREATE_ROOM":
		s.createRoom(client, message.Name, message.TurnTimerSeconds, message.GameOverScore)
	case "JOIN_ROOM":
		s.joinRoom(client, message.RoomCode, message.Name)
	case "REJOIN_ROOM":
		s.rejoinRoom(client, message.RoomCode, message.SessionID)
	case "ADD_BOT":
		s.addBot(client)
	case "REMOVE_BOT":
		s.removeBot(client, message.PlayerID)
	case "SET_READY":
		s.setReady(client, message.Ready)
	case "KICK_PLAYER":
		s.kickPlayer(client, message.PlayerID)
	case "LEAVE_ROOM":
		s.leaveRoom(client)
	case "DELETE_ROOM":
		s.deleteRoom(client)
	case "START_GAME":
		s.startGame(client)
	case "DISCARD_CARDS":
		s.applyPlayerAction(client, game.Action{Type: "DISCARD_CARDS", CardIDs: message.CardIDs})
	case "DRAW_CARD":
		s.applyPlayerAction(client, game.Action{Type: "DRAW_CARD", Source: message.Source})
	case "CALL_GANJI":
		s.applyPlayerAction(client, game.Action{Type: "CALL_GANJI"})
	case "END_TURN":
		s.applyPlayerAction(client, game.Action{Type: "END_TURN"})
	case "START_NEXT_ROUND":
		s.applyRoomAction(client, game.Action{Type: "START_NEXT_ROUND"})
	}
}

func (s *Server) createRoom(client *Client, name string, turnTimerSeconds int, gameOverScore int) {
	s.detachClient(client)

	roomCode := s.createRoomCode()
	sessionID := createID()
	player := ServerPlayer{
		ID:                      "player-1",
		Name:                    normalizeName(name, "Host"),
		IsBot:                   false,
		Connected:               true,
		Ready:                   true,
		SubstituteActive:        false,
		SessionID:               sessionID,
		DisconnectedTimeoutUsed: false,
	}
	room := &Room{
		server:               s,
		RoomCode:             roomCode,
		HostPlayerID:         player.ID,
		Players:              []ServerPlayer{player},
		GameState:            nil,
		Sockets:              map[string]*Client{},
		NextPlayerNumber:     2,
		NextBotNumber:        1,
		BotTimer:             nil,
		TurnTimer:            nil,
		InactiveCleanupTimer: nil,
		TurnTimerSeconds:     normalizeTurnTimerSeconds(turnTimerSeconds),
		GameOverScore:        game.NormalizeGameOverScore(gameOverScore),
		TurnDeadline:         nil,
		TurnTimerKey:         "",
		Message:              fmt.Sprintf("Room %s created. Share the code with friends.", roomCode),
	}

	s.mu.Lock()
	s.rooms[roomCode] = room
	s.mu.Unlock()

	room.mu.Lock()
	attachClientLocked(client, room, player.ID, sessionID)
	broadcastRoomLocked(room)
	room.mu.Unlock()
}

func (s *Server) joinRoom(client *Client, roomCodeInput string, name string) {
	s.detachClient(client)

	roomCode := strings.ToUpper(strings.TrimSpace(roomCodeInput))
	room := s.getRoom(roomCode)
	if room == nil {
		sendErrorCode(client, "ROOM_NOT_FOUND", "Room not found.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "This room already started. Rejoin with your saved session instead.")
		return
	}

	if len(room.Players) >= game.MaxPlayers {
		sendError(client, "This room is full.")
		return
	}

	sessionID := createID()
	player := ServerPlayer{
		ID:                      fmt.Sprintf("player-%d", room.NextPlayerNumber),
		Name:                    normalizeName(name, fmt.Sprintf("Player %d", room.NextPlayerNumber)),
		IsBot:                   false,
		Connected:               true,
		Ready:                   false,
		SubstituteActive:        false,
		SessionID:               sessionID,
		DisconnectedTimeoutUsed: false,
	}

	room.NextPlayerNumber++
	room.Players = append(room.Players, player)
	room.Message = fmt.Sprintf("%s joined the room.", player.Name)
	attachClientLocked(client, room, player.ID, sessionID)
	broadcastRoomLocked(room)
}

func (s *Server) rejoinRoom(client *Client, roomCodeInput string, sessionID string) {
	s.detachClient(client)
	if strings.TrimSpace(sessionID) == "" {
		sendErrorCode(client, "SESSION_NOT_FOUND", "Saved session was not found for this room.")
		return
	}

	room := s.getRoom(strings.ToUpper(strings.TrimSpace(roomCodeInput)))
	if room == nil {
		sendErrorCode(client, "ROOM_NOT_FOUND", "Room not found.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	playerIndex := -1
	for index, player := range room.Players {
		if player.SessionID != "" && player.SessionID == sessionID {
			playerIndex = index
			break
		}
	}
	if playerIndex == -1 {
		sendErrorCode(client, "SESSION_NOT_FOUND", "Saved session was not found for this room.")
		return
	}

	player := room.Players[playerIndex]
	room.Message = fmt.Sprintf("%s reconnected.", player.Name)
	attachClientLocked(client, room, player.ID, sessionID)
	if room.TurnDeadline == nil || room.TurnTimerKey == "" {
		startTurnTimerLocked(room)
	}
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func (s *Server) addBot(client *Client) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before adding bots.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if !isHostLocked(client, room) {
		sendError(client, "Only the host can add bots.")
		return
	}

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "Bots can only be added before the game starts.")
		return
	}

	if len(room.Players) >= game.MaxPlayers {
		sendError(client, "This room is already full.")
		return
	}

	bot := ServerPlayer{
		ID:                      fmt.Sprintf("player-%d", room.NextPlayerNumber),
		Name:                    fmt.Sprintf("BOT %d", room.NextBotNumber),
		IsBot:                   true,
		Connected:               true,
		Ready:                   true,
		SubstituteActive:        false,
		DisconnectedTimeoutUsed: false,
	}

	room.NextPlayerNumber++
	room.NextBotNumber++
	room.Players = append(room.Players, bot)
	room.Message = fmt.Sprintf("%s joined the table.", bot.Name)
	broadcastRoomLocked(room)
}

func (s *Server) removeBot(client *Client, playerID string) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before removing bots.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if !isHostLocked(client, room) {
		sendError(client, "Only the host can remove bots.")
		return
	}

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "Bots can only be removed before the game starts.")
		return
	}

	botIndex := -1
	var bot ServerPlayer
	for index, player := range room.Players {
		if player.ID == playerID && player.IsBot {
			botIndex = index
			bot = player
			break
		}
	}
	if botIndex == -1 {
		sendError(client, "Bot not found.")
		return
	}

	room.Players = append(room.Players[:botIndex], room.Players[botIndex+1:]...)
	room.Message = fmt.Sprintf("%s left the table.", bot.Name)
	broadcastRoomLocked(room)
}

func (s *Server) setReady(client *Client, ready bool) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before changing ready status.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "Ready status can only be changed before the game starts.")
		return
	}

	_, playerID, _ := client.data()
	playerIndex := findServerPlayerIndexLocked(room, playerID)
	if playerIndex == -1 {
		sendError(client, "Player not found.")
		return
	}

	if room.Players[playerIndex].ID == room.HostPlayerID || room.Players[playerIndex].IsBot {
		room.Players[playerIndex].Ready = true
	} else {
		room.Players[playerIndex].Ready = ready
	}

	room.Message = fmt.Sprintf("%s is %s.", room.Players[playerIndex].Name, readyText(room.Players[playerIndex].Ready))
	broadcastRoomLocked(room)
}

func (s *Server) kickPlayer(client *Client, playerID string) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before kicking players.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if !isHostLocked(client, room) {
		sendError(client, "Only the host can kick players.")
		return
	}

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "Players can only be kicked before the game starts.")
		return
	}

	playerIndex := findServerPlayerIndexLocked(room, playerID)
	if playerIndex == -1 || room.Players[playerIndex].IsBot || room.Players[playerIndex].ID == room.HostPlayerID {
		sendError(client, "That player cannot be kicked.")
		return
	}
	player := room.Players[playerIndex]

	for socketID, playerClient := range room.Sockets {
		_, socketPlayerID, _ := playerClient.data()
		if socketPlayerID == player.ID {
			sendError(playerClient, "You were kicked from the room. You can rejoin with the room code.")
			playerClient.clearData()
			delete(room.Sockets, socketID)
		}
	}

	room.Players = append(room.Players[:playerIndex], room.Players[playerIndex+1:]...)
	room.Message = fmt.Sprintf("%s was kicked from the room.", player.Name)
	updateConnectionFlagsLocked(room)
	broadcastRoomLocked(room)
}

func (s *Server) leaveRoom(client *Client) {
	room := s.getClientRoom(client)
	if room == nil {
		client.clearData()
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	_, playerID, _ := client.data()
	delete(room.Sockets, client.socketID)
	client.clearData()

	playerIndex := findServerPlayerIndexLocked(room, playerID)
	if playerIndex == -1 {
		updateConnectionFlagsLocked(room)
		updateInactiveCleanupLocked(room)
		broadcastRoomLocked(room)
		return
	}

	player := room.Players[playerIndex]
	if getRoomStatusLocked(room) == "lobby" {
		wasHost := player.ID == room.HostPlayerID
		room.Players = append(room.Players[:playerIndex], room.Players[playerIndex+1:]...)
		updateConnectionFlagsLocked(room)

		if !hasHumanPlayerLocked(room) {
			closeRoomLocked(room, fmt.Sprintf("%s left room %s.", player.Name, room.RoomCode))
			return
		}

		if wasHost {
			room.HostPlayerID = ""
			newHost := ensureActiveHostLocked(room)
			if newHost != nil {
				room.Message = fmt.Sprintf("%s left the room. %s is now the host.", player.Name, newHost.Name)
			} else {
				room.Message = fmt.Sprintf("%s left the room.", player.Name)
			}
		} else {
			room.Message = fmt.Sprintf("%s left the room.", player.Name)
		}

		updateInactiveCleanupLocked(room)
		broadcastRoomLocked(room)
		return
	}

	updateConnectionFlagsLocked(room)
	playerIndex = findServerPlayerIndexLocked(room, player.ID)
	if playerIndex != -1 && !room.Players[playerIndex].Connected {
		room.Players[playerIndex].SubstituteActive = false
		room.Players[playerIndex].DisconnectedTimeoutUsed = false
		room.Message = fmt.Sprintf("%s left the room.", room.Players[playerIndex].Name)
	}
	ensureActiveHostLocked(room)

	if !hasConnectedHumanLocked(room) {
		clearBotTimerLocked(room)
		clearTurnTimerLocked(room)
		room.TurnDeadline = nil
		room.TurnTimerKey = ""
	}

	updateInactiveCleanupLocked(room)
	broadcastRoomLocked(room)
}

func (s *Server) deleteRoom(client *Client) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before deleting it.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if !isHostLocked(client, room) {
		sendError(client, "Only the host can delete this room.")
		return
	}

	hostName := "The host"
	if host := getServerPlayerLocked(room, room.HostPlayerID); host != nil {
		hostName = host.Name
	}
	closeRoomLocked(room, fmt.Sprintf("%s deleted room %s.", hostName, room.RoomCode))
}

func (s *Server) startGame(client *Client) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "Join a room before starting a game.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if !isHostLocked(client, room) {
		sendError(client, "Only the host can start the game.")
		return
	}

	if getRoomStatusLocked(room) != "lobby" {
		sendError(client, "The game already started.")
		return
	}

	if len(room.Players) < game.MinPlayers {
		sendError(client, fmt.Sprintf("Ganji needs at least %d players or bots.", game.MinPlayers))
		return
	}

	updateConnectionFlagsLocked(room)
	for _, player := range room.Players {
		if !player.IsBot && !player.Connected {
			sendError(client, fmt.Sprintf("%s must reconnect before the game starts.", player.Name))
			return
		}
	}

	for _, player := range room.Players {
		if !player.Ready {
			sendError(client, "Every player must be ready before the game starts.")
			return
		}
	}

	setupPlayers := make([]game.SetupPlayerConfig, 0, len(room.Players))
	for _, player := range room.Players {
		setupPlayers = append(setupPlayers, game.SetupPlayerConfig{ID: player.ID, Name: player.Name, IsBot: player.IsBot})
	}

	gameState := game.Reduce(game.InitialState(), game.Action{Type: "START_GAME", Players: setupPlayers, GameOverScore: room.GameOverScore})
	room.GameState = &gameState
	room.Message = "Game started."
	startTurnTimerLocked(room)
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func (s *Server) applyPlayerAction(client *Client, action game.Action) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "The game has not started.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if room.GameState == nil {
		sendError(client, "The game has not started.")
		return
	}

	currentPlayer := getCurrentPlayerLocked(*room.GameState)
	if currentPlayer == nil {
		sendError(client, "No current player found.")
		return
	}

	if isServerControlledPlayerLocked(room, *currentPlayer) {
		sendError(client, "The server controls this turn.")
		return
	}

	_, playerID, _ := client.data()
	if currentPlayer.ID != playerID {
		sendError(client, fmt.Sprintf("It is %s's turn.", currentPlayer.Name))
		return
	}

	previousGameState := *room.GameState
	gameState := game.Reduce(previousGameState, action)
	room.GameState = &gameState
	room.Message = gameState.Message
	if gameStateAdvanced(previousGameState, gameState) {
		startTurnTimerLocked(room)
	}
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func (s *Server) applyRoomAction(client *Client, action game.Action) {
	room := s.getClientRoom(client)
	if room == nil {
		sendError(client, "The game has not started.")
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	if room.GameState == nil {
		sendError(client, "The game has not started.")
		return
	}
	if action.Type == "START_NEXT_ROUND" && !isHostLocked(client, room) {
		sendError(client, "Only the host can start the next round.")
		return
	}

	previousGameState := *room.GameState
	gameState := game.Reduce(previousGameState, action)
	room.GameState = &gameState
	room.Message = gameState.Message
	if gameStateAdvanced(previousGameState, gameState) {
		startTurnTimerLocked(room)
	}
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func (s *Server) detachClient(client *Client) {
	roomCode, playerID, _ := client.data()
	if roomCode == "" {
		return
	}

	room := s.getRoom(roomCode)
	if room == nil {
		client.clearData()
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	delete(room.Sockets, client.socketID)
	updateConnectionFlagsLocked(room)

	playerIndex := findServerPlayerIndexLocked(room, playerID)
	if playerIndex != -1 && !room.Players[playerIndex].Connected {
		room.Players[playerIndex].SubstituteActive = false
		room.Players[playerIndex].DisconnectedTimeoutUsed = false
		room.Message = fmt.Sprintf("%s disconnected.", room.Players[playerIndex].Name)
	}
	ensureActiveHostLocked(room)

	client.clearData()

	if !hasConnectedHumanLocked(room) {
		clearBotTimerLocked(room)
		clearTurnTimerLocked(room)
		room.TurnDeadline = nil
		room.TurnTimerKey = ""
	}

	updateInactiveCleanupLocked(room)
	broadcastRoomLocked(room)
}

func (s *Server) getRoom(roomCode string) *Room {
	s.mu.RLock()
	room := s.rooms[roomCode]
	s.mu.RUnlock()
	return room
}

func (s *Server) getClientRoom(client *Client) *Room {
	roomCode, _, _ := client.data()
	if roomCode == "" {
		return nil
	}
	return s.getRoom(roomCode)
}

func attachClientLocked(client *Client, room *Room, playerID string, sessionID string) {
	client.setData(room.RoomCode, playerID, sessionID)
	room.Sockets[client.socketID] = client

	playerIndex := findServerPlayerIndexLocked(room, playerID)
	if playerIndex != -1 {
		room.Players[playerIndex].SubstituteActive = false
		room.Players[playerIndex].DisconnectedTimeoutUsed = false
	}

	updateConnectionFlagsLocked(room)
	ensureActiveHostLocked(room)
	updateInactiveCleanupLocked(room)
}

func scheduleBotTurnLocked(room *Room) {
	if room.BotTimer != nil || !hasConnectedHumanLocked(room) || room.GameState == nil || room.GameState.Status != game.StatusPlaying {
		return
	}

	currentPlayer := getCurrentPlayerLocked(*room.GameState)
	if currentPlayer == nil || !isServerControlledPlayerLocked(room, *currentPlayer) {
		return
	}

	room.BotTimer = time.AfterFunc(700*time.Millisecond, func() {
		processBotTurn(room)
	})
}

func processBotTurn(room *Room) {
	room.mu.Lock()
	defer room.mu.Unlock()

	room.BotTimer = nil
	if !hasConnectedHumanLocked(room) || room.GameState == nil || room.GameState.Status != game.StatusPlaying {
		return
	}

	currentPlayer := getCurrentPlayerLocked(*room.GameState)
	if currentPlayer == nil || !isServerControlledPlayerLocked(room, *currentPlayer) {
		return
	}

	handValue := game.CalculateHandValue(currentPlayer.Hand)
	var action game.Action
	if room.GameState.Phase == game.PhaseDiscard && handValue <= game.GanjiLimit {
		action = game.Action{Type: "CALL_GANJI"}
	} else if room.GameState.Phase == game.PhaseDiscard {
		discardCards := game.ChooseBotDiscard(currentPlayer.Hand)
		cardIDs := make([]string, len(discardCards))
		for index, card := range discardCards {
			cardIDs[index] = card.ID
		}
		action = game.Action{Type: "DISCARD_CARDS", CardIDs: cardIDs}
	} else if room.GameState.Phase == game.PhaseDraw {
		action = game.Action{Type: "DRAW_CARD", Source: game.ChooseBotDrawSource(*room.GameState)}
	} else {
		action = game.Action{Type: "END_TURN"}
	}

	gameState := game.Reduce(*room.GameState, action)
	room.GameState = &gameState
	room.Message = gameState.Message
	startTurnTimerLocked(room)
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func startTurnTimerLocked(room *Room) {
	clearTurnTimerLocked(room)
	room.TurnTimerGeneration++
	turnTimerGeneration := room.TurnTimerGeneration

	if !hasConnectedHumanLocked(room) || room.GameState == nil || room.GameState.Status != game.StatusPlaying {
		room.TurnDeadline = nil
		room.TurnTimerKey = ""
		return
	}

	currentPlayer := getCurrentPlayerLocked(*room.GameState)
	if currentPlayer == nil {
		room.TurnDeadline = nil
		room.TurnTimerKey = ""
		return
	}

	turnTimerKey := createTurnTimerKey(*room.GameState)
	deadline := time.Now().Add(time.Duration(room.TurnTimerSeconds) * time.Second).UnixMilli()
	room.TurnTimerKey = turnTimerKey
	room.TurnDeadline = &deadline
	room.TurnTimer = time.AfterFunc(time.Duration(room.TurnTimerSeconds)*time.Second, func() {
		processTurnTimeout(room, turnTimerKey, turnTimerGeneration)
	})
}

func processTurnTimeout(room *Room, turnTimerKey string, turnTimerGeneration int64) {
	room.mu.Lock()
	defer room.mu.Unlock()

	room.TurnTimer = nil
	if room.GameState == nil || room.GameState.Status != game.StatusPlaying || turnTimerKey == "" || room.TurnTimerGeneration != turnTimerGeneration || room.TurnTimerKey != turnTimerKey || createTurnTimerKey(*room.GameState) != turnTimerKey {
		return
	}

	currentPlayer := getCurrentPlayerLocked(*room.GameState)
	if currentPlayer == nil {
		return
	}

	serverPlayer := getServerPlayerLocked(room, currentPlayer.ID)
	action := createTimeoutAction(*room.GameState, *currentPlayer)
	gameState := game.Reduce(*room.GameState, action)
	room.GameState = &gameState

	shouldStartSubstitute := serverPlayer != nil && !serverPlayer.IsBot && !serverPlayer.Connected && !serverPlayer.SubstituteActive
	if shouldStartSubstitute {
		playerIndex := findServerPlayerIndexLocked(room, serverPlayer.ID)
		if playerIndex != -1 {
			room.Players[playerIndex].SubstituteActive = true
			room.Players[playerIndex].DisconnectedTimeoutUsed = true
		}
	}

	if shouldStartSubstitute {
		room.Message = fmt.Sprintf("%s ran out of time. A BOT is now playing their seat. %s", currentPlayer.Name, room.GameState.Message)
	} else {
		room.Message = fmt.Sprintf("%s ran out of time. %s", currentPlayer.Name, room.GameState.Message)
	}
	startTurnTimerLocked(room)
	broadcastRoomLocked(room)
	scheduleBotTurnLocked(room)
}

func createTimeoutAction(gameState game.GameState, currentPlayer game.Player) game.Action {
	if gameState.Phase == game.PhaseDiscard {
		discardCards := game.ChooseBotDiscard(currentPlayer.Hand)
		cardIDs := make([]string, len(discardCards))
		for index, card := range discardCards {
			cardIDs[index] = card.ID
		}
		return game.Action{Type: "DISCARD_CARDS", CardIDs: cardIDs}
	}

	if gameState.Phase == game.PhaseDraw {
		return game.Action{Type: "DRAW_CARD", Source: game.ChooseBotDrawSource(gameState)}
	}

	return game.Action{Type: "END_TURN"}
}

func clearTurnTimerLocked(room *Room) {
	room.TurnTimerGeneration++
	if room.TurnTimer != nil {
		room.TurnTimer.Stop()
		room.TurnTimer = nil
	}
}

func clearBotTimerLocked(room *Room) {
	if room.BotTimer != nil {
		room.BotTimer.Stop()
		room.BotTimer = nil
	}
}

func clearInactiveCleanupTimerLocked(room *Room) {
	if room.InactiveCleanupTimer != nil {
		room.InactiveCleanupTimer.Stop()
		room.InactiveCleanupTimer = nil
	}
}

func closeRoomLocked(room *Room, message string) {
	clearBotTimerLocked(room)
	clearTurnTimerLocked(room)
	clearInactiveCleanupTimerLocked(room)

	room.server.mu.Lock()
	delete(room.server.rooms, room.RoomCode)
	room.server.mu.Unlock()

	for _, client := range room.Sockets {
		client.sendJSON(serverMessage{Type: "ROOM_CLOSED", RoomCode: room.RoomCode, Message: message})
		client.clearData()
	}
	room.Sockets = map[string]*Client{}
}

func updateInactiveCleanupLocked(room *Room) {
	if hasConnectedHumanLocked(room) {
		clearInactiveCleanupTimerLocked(room)
		return
	}

	if room.InactiveCleanupTimer != nil {
		return
	}

	roomCode := room.RoomCode
	room.InactiveCleanupTimer = time.AfterFunc(inactiveRoomTimeout, func() {
		cleanupInactiveRoom(room.server, roomCode)
	})
}

func cleanupInactiveRoom(server *Server, roomCode string) {
	room := server.getRoom(roomCode)
	if room == nil {
		return
	}

	room.mu.Lock()
	defer room.mu.Unlock()

	updateConnectionFlagsLocked(room)
	if !hasConnectedHumanLocked(room) {
		closeRoomLocked(room, fmt.Sprintf("Room %s was removed after 15 minutes of inactivity.", room.RoomCode))
	}
}

func broadcastRoomLocked(room *Room) {
	updateConnectionFlagsLocked(room)
	for _, client := range room.Sockets {
		sendRoomUpdateLocked(client, room)
	}
}

func sendRoomUpdateLocked(client *Client, room *Room) {
	_, playerID, sessionID := client.data()
	if playerID == "" || sessionID == "" {
		return
	}

	client.sendJSON(serverMessage{
		Type:      "ROOM_UPDATE",
		SessionID: sessionID,
		Room:      createRoomViewLocked(room, playerID),
	})
}

func createRoomViewLocked(room *Room, viewerPlayerID string) *RoomView {
	players := make([]OnlineLobbyPlayer, len(room.Players))
	for index, player := range room.Players {
		players[index] = OnlineLobbyPlayer{
			ID:               player.ID,
			Name:             player.Name,
			IsBot:            player.IsBot,
			Connected:        player.Connected,
			Ready:            player.Ready,
			SubstituteActive: player.SubstituteActive,
		}
	}

	var gameState *game.GameState
	if room.GameState != nil {
		redacted := redactGameState(*room.GameState, viewerPlayerID)
		gameState = &redacted
	}

	return &RoomView{
		RoomCode:         room.RoomCode,
		Status:           getRoomStatusLocked(room),
		Players:          players,
		GameState:        gameState,
		ViewerPlayerID:   viewerPlayerID,
		HostPlayerID:     room.HostPlayerID,
		TurnTimerSeconds: room.TurnTimerSeconds,
		GameOverScore:    room.GameOverScore,
		TurnDeadline:     room.TurnDeadline,
		Message:          room.Message,
	}
}

func redactGameState(gameState game.GameState, viewerPlayerID string) game.GameState {
	revealAllHands := gameState.Status != game.StatusPlaying
	players := make([]game.Player, len(gameState.Players))
	for index, player := range gameState.Players {
		players[index] = player
		if revealAllHands || player.ID == viewerPlayerID {
			players[index].Hand = copyCards(player.Hand)
		} else {
			players[index].Hand = createHiddenCards(len(player.Hand), player.ID)
		}
	}

	gameState.Players = players
	gameState.Deck = createHiddenCards(len(gameState.Deck), "deck")
	gameState.DiscardPile = createHiddenCards(len(gameState.DiscardPile), "discard")
	return gameState
}

func createHiddenCards(count int, owner string) []game.Card {
	cards := make([]game.Card, count)
	for index := range cards {
		cards[index] = game.Card{ID: fmt.Sprintf("hidden-%s-%d", owner, index), Rank: game.RankAce, Suit: game.SuitSpades, Value: 0}
	}
	return cards
}

func updateConnectionFlagsLocked(room *Room) {
	for playerIndex := range room.Players {
		if room.Players[playerIndex].IsBot || room.Players[playerIndex].ID == room.HostPlayerID {
			room.Players[playerIndex].Ready = true
		}

		connected := room.Players[playerIndex].IsBot
		if !connected {
			for _, client := range room.Sockets {
				_, socketPlayerID, _ := client.data()
				if socketPlayerID == room.Players[playerIndex].ID {
					connected = true
					break
				}
			}
		}
		room.Players[playerIndex].Connected = connected
	}
}

func getCurrentPlayerLocked(gameState game.GameState) *game.Player {
	if gameState.CurrentPlayerIndex < 0 || gameState.CurrentPlayerIndex >= len(gameState.Players) {
		return nil
	}
	return &gameState.Players[gameState.CurrentPlayerIndex]
}

func getServerPlayerLocked(room *Room, playerID string) *ServerPlayer {
	index := findServerPlayerIndexLocked(room, playerID)
	if index == -1 {
		return nil
	}
	return &room.Players[index]
}

func findServerPlayerIndexLocked(room *Room, playerID string) int {
	for index, player := range room.Players {
		if player.ID == playerID {
			return index
		}
	}
	return -1
}

func isServerControlledPlayerLocked(room *Room, player game.Player) bool {
	serverPlayer := getServerPlayerLocked(room, player.ID)
	return player.IsBot || (serverPlayer != nil && (serverPlayer.IsBot || (serverPlayer.SubstituteActive && !serverPlayer.Connected)))
}

func ensureActiveHostLocked(room *Room) *ServerPlayer {
	currentHost := getServerPlayerLocked(room, room.HostPlayerID)
	if currentHost != nil && !currentHost.IsBot && currentHost.Connected {
		return currentHost
	}

	for index := range room.Players {
		if !room.Players[index].IsBot && room.Players[index].Connected {
			room.HostPlayerID = room.Players[index].ID
			room.Players[index].Ready = true
			return &room.Players[index]
		}
	}

	return nil
}

func hasConnectedHumanLocked(room *Room) bool {
	for _, player := range room.Players {
		if !player.IsBot && player.Connected {
			return true
		}
	}
	return false
}

func hasHumanPlayerLocked(room *Room) bool {
	for _, player := range room.Players {
		if !player.IsBot {
			return true
		}
	}
	return false
}

func getRoomStatusLocked(room *Room) string {
	if room.GameState == nil {
		return "lobby"
	}

	if room.GameState.Status == game.StatusSetup {
		return "lobby"
	}
	return string(room.GameState.Status)
}

func isHostLocked(client *Client, room *Room) bool {
	_, playerID, _ := client.data()
	return playerID == room.HostPlayerID
}

func sendError(client *Client, message string) {
	client.sendJSON(serverMessage{Type: "ERROR", Message: message})
}

func sendErrorCode(client *Client, code string, message string) {
	client.sendJSON(serverMessage{Type: "ERROR", Code: code, Message: message})
}

func gameStateAdvanced(previous game.GameState, next game.GameState) bool {
	if previous.Status != next.Status || previous.Phase != next.Phase || previous.CurrentPlayerIndex != next.CurrentPlayerIndex || previous.RoundNumber != next.RoundNumber || previous.GameOverScore != next.GameOverScore {
		return true
	}
	if len(previous.Deck) != len(next.Deck) || len(previous.DiscardPile) != len(next.DiscardPile) {
		return true
	}
	if !drawOffersEqual(previous.DrawOffer, next.DrawOffer) || !drawOffersEqual(previous.PendingNextOffer, next.PendingNextOffer) {
		return true
	}
	if (previous.RoundSummary == nil) != (next.RoundSummary == nil) || !stringSlicesEqual(previous.WinnerIDs, next.WinnerIDs) {
		return true
	}
	if len(previous.Players) != len(next.Players) {
		return true
	}
	for index := range previous.Players {
		previousPlayer := previous.Players[index]
		nextPlayer := next.Players[index]
		if previousPlayer.ID != nextPlayer.ID || previousPlayer.TotalScore != nextPlayer.TotalScore || len(previousPlayer.Hand) != len(nextPlayer.Hand) {
			return true
		}
		for cardIndex := range previousPlayer.Hand {
			if previousPlayer.Hand[cardIndex].ID != nextPlayer.Hand[cardIndex].ID {
				return true
			}
		}
	}
	return false
}

func drawOffersEqual(first *game.DrawOffer, second *game.DrawOffer) bool {
	if first == nil || second == nil {
		return first == second
	}
	return first.Card.ID == second.Card.ID && first.FromPlayerID == second.FromPlayerID && first.DiscardedCount == second.DiscardedCount
}

func stringSlicesEqual(first []string, second []string) bool {
	if len(first) != len(second) {
		return false
	}
	for index := range first {
		if first[index] != second[index] {
			return false
		}
	}
	return true
}

func (s *Server) createRoomCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	for {
		bytes := make([]byte, 6)
		if _, err := rand.Read(bytes); err != nil {
			panic(err)
		}

		codeBytes := make([]byte, len(bytes))
		for index, value := range bytes {
			codeBytes[index] = alphabet[int(value)%len(alphabet)]
		}
		code := string(codeBytes)

		s.mu.RLock()
		_, exists := s.rooms[code]
		s.mu.RUnlock()
		if !exists {
			return code
		}
	}
}

func createTurnTimerKey(gameState game.GameState) string {
	currentPlayer := getCurrentPlayerLocked(gameState)
	playerID := "none"
	if currentPlayer != nil {
		playerID = currentPlayer.ID
	}
	return fmt.Sprintf("%d:%d:%s:%s", gameState.RoundNumber, gameState.CurrentPlayerIndex, playerID, gameState.Phase)
}

func createID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(bytes[0:4]), hex.EncodeToString(bytes[4:6]), hex.EncodeToString(bytes[6:8]), hex.EncodeToString(bytes[8:10]), hex.EncodeToString(bytes[10:16]))
}

func normalizeName(name string, fallback string) string {
	trimmedName := strings.TrimSpace(name)
	if trimmedName != "" {
		runes := []rune(trimmedName)
		if len(runes) > maxPlayerNameRuneCount {
			return string(runes[:maxPlayerNameRuneCount])
		}
		return trimmedName
	}
	return fallback
}

func normalizeTurnTimerSeconds(turnTimerSeconds int) int {
	allowedTimers := []int{30, 60, 90, 120}
	for _, allowedTimer := range allowedTimers {
		if turnTimerSeconds == allowedTimer {
			return turnTimerSeconds
		}
	}
	return 60
}

func readyText(ready bool) string {
	if ready {
		return "ready"
	}
	return "not ready"
}

func copyCards(cards []game.Card) []game.Card {
	copied := make([]game.Card, len(cards))
	copy(copied, cards)
	return copied
}
