package main

import (
	"log"
	"os"
	"strings"

	"playganji/internal/server"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	ganjiServer := server.New("dist")
	listenAddrs := listenAddresses(port)
	errCh := make(chan error, len(listenAddrs))
	for _, addr := range listenAddrs {
		addr := addr
		log.Printf("Ganji server listening on http://%s", displayAddress(addr))
		go func() {
			errCh <- ganjiServer.ListenAndServe(addr)
		}()
	}

	log.Fatal(<-errCh)
}

func listenAddresses(port string) []string {
	configuredAddrs := strings.TrimSpace(os.Getenv("LISTEN_ADDRS"))
	if configuredAddrs == "" {
		return []string{":" + port}
	}

	addrs := []string{}
	for _, addr := range strings.Split(configuredAddrs, ",") {
		addr = strings.TrimSpace(addr)
		if addr != "" {
			addrs = append(addrs, addr)
		}
	}
	if len(addrs) == 0 {
		return []string{":" + port}
	}

	return addrs
}

func displayAddress(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "localhost" + addr
	}

	return addr
}
