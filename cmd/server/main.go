package main

import (
	"log"
	"os"

	"playganji/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	ganjiServer := server.New("dist")
	addr := ":" + port
	log.Printf("Ganji server listening on http://localhost:%s", port)
	if err := ganjiServer.ListenAndServe(addr); err != nil {
		log.Fatal(err)
	}
}
