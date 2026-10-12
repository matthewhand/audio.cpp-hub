package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

// boundedWriteListener keeps the kernel TCP send queue small. This makes a
// stopped reader block a 1 MiB SSE write without allocating a huge payload.
type boundedWriteListener struct{ net.Listener }

func (l boundedWriteListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tcp, ok := c.(*net.TCPConn)
	if !ok {
		c.Close()
		return nil, fmt.Errorf("loopback listener returned %T, want *net.TCPConn", c)
	}
	if err := tcp.SetWriteBuffer(4096); err != nil {
		c.Close()
		return nil, err
	}
	return tcp, nil
}

func TestSSEWriteDeadlineExpiresOnStalledLoopbackTCP(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("test relies on Linux loopback TCP socket-buffer behaviour")
	}

	// Deliberately do not read the HTTP response until the server write ends.
	// The client remains connected; cancellation or client disconnect must NOT
	// be the mechanism which frees the writer.
	frame := []byte("event: stalled\ndata: " + strings.Repeat("x", 1<<20) + "\n\n")
	type outcome struct {
		elapsed time.Duration
		err     error
	}
	started := make(chan struct{}, 1)
	result := make(chan outcome, 1)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		started <- struct{}{}
		before := time.Now()
		err := writeSSEFrame(w, http.NewResponseController(w), frame)
		result <- outcome{elapsed: time.Since(before), err: err}
	})
	server := httptest.NewUnstartedServer(h)
	server.Listener = boundedWriteListener{Listener: server.Listener}
	server.Start()
	defer server.Close()

	client, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	tcp := client.(*net.TCPConn)
	if err := tcp.SetReadBuffer(4096); err != nil {
		t.Fatal(err)
	}
	// One small request, then stop all reads. The 10s server write deadline
	// must terminate the blocked frame before the 16s outer test bound.
	if _, err := fmt.Fprintf(client, "GET /api/events/stream HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("loopback SSE handler never began")
	}
	select {
	case out := <-result:
		if out.err == nil {
			t.Fatalf("1 MiB SSE frame unexpectedly flushed to a nonreading TCP peer after %s", out.elapsed)
		}
		var ne net.Error
		if !errors.As(out.err, &ne) || !ne.Timeout() {
			t.Fatalf("blocked SSE write returned non-timeout error after %s: %v", out.elapsed, out.err)
		}
		if out.elapsed < sseWriteTimeout-250*time.Millisecond || out.elapsed > sseWriteTimeout+4*time.Second {
			t.Fatalf("SSE write timeout took %s, expected near deadline %s", out.elapsed, sseWriteTimeout)
		}
		t.Logf("real stalled TCP write ended with timeout in %s; payload=%d bytes; server send/client receive buffers=4096 bytes", out.elapsed, len(frame))
	case <-time.After(sseWriteTimeout + 6*time.Second):
		t.Fatalf("SSE write remained blocked past %s deadline + 6s bound", sseWriteTimeout)
	}
}
