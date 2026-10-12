//go:build windows

package main

// Windows-only, opt-in tests for Issue #155 / PR #156. These tests are NOT
// registered in default CI. W01/W05 use real local Winsock via httptest;
// W06 deliberately uses net.Pipe, not Winsock, for deterministic backpressure.
// Running these on Windows requires separate owner approval.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const win156Endpoint = "/api/events/stream"

func win156WaitSlots(t *testing.T, bus *EventBus, want int) {
	t.Helper()
	limit := time.NewTimer(2 * time.Second)
	defer limit.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if got := qa135Subscribers(bus); got == want {
			return
		}
		select {
		case <-tick.C:
		case <-limit.C:
			t.Fatalf("SSE subscriber slots did not reach %d (got %d)", want, qa135Subscribers(bus))
		}
	}
}

func win156WaitHandler(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("SSE handler did not exit on disconnect/shutdown")
	}
}

type win156DeadlineConn struct {
	net.Conn
	deadlines chan time.Time
}

func (c *win156DeadlineConn) SetWriteDeadline(d time.Time) error {
	select {
	case c.deadlines <- d:
	default:
	}
	return c.Conn.SetWriteDeadline(d)
}

type win156DeadlineListener struct {
	net.Listener
	deadlines chan time.Time
}

func (l *win156DeadlineListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &win156DeadlineConn{Conn: conn, deadlines: l.deadlines}, nil
}

// W01 is a real native-Winsock loopback smoke test, not a net.Pipe proof.
// It checks HTTP 200/hello and observes actual response-connection deadlines.
func TestSSEWinNativeW01LoopbackHelloAndDeadlines(t *testing.T) {
	bus := NewEventBus()
	listenerDeadlines := make(chan time.Time, 8)
	srv := httptest.NewUnstartedServer((&Hub{bus: bus}).newHandler())
	srv.Listener = &win156DeadlineListener{Listener: srv.Listener, deadlines: listenerDeadlines}
	srv.Start()
	t.Cleanup(func() { bus.Close(); srv.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+win156Endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("W01 status=%d content-type=%q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if frame := readSSE(t, bufio.NewReader(resp.Body), time.Second); frame.name != "hello" {
		t.Fatalf("W01 first frame=%q, want hello", frame.name)
	}
	for i := 0; i < 2; i++ { // preflight, then per-hello refresh
		select {
		case deadline := <-listenerDeadlines:
			if deadline.Before(time.Now()) || deadline.After(time.Now().Add(sseWriteTimeout+time.Second)) {
				t.Fatalf("W01 unexpected write deadline #%d: %s", i, deadline)
			}
		case <-time.After(time.Second):
			t.Fatalf("W01 observed only %d deadline calls; expected preflight and hello refresh", i)
		}
	}
	cancel()
	resp.Body.Close()
	win156WaitSlots(t, bus, 0)
}

// W02 rejects a writer without SetWriteDeadline, before any SSE 200/header,
// then verifies admission is reclaimable. It never opens a native socket.
func TestSSEWinNativeW02UnsupportedDeadlineFailsClosed(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	w := httptest.NewRecorder()
	(&Hub{bus: bus}).handleEventStream(w, httptest.NewRequest(http.MethodGet, win156Endpoint, nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "EVENTS_DEADLINE_UNSUPPORTED") {
		t.Fatalf("W02 status=%d body=%q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatal("W02 incorrectly returned SSE content type")
	}
	win156WaitSlots(t, bus, 0)
	if replacement := bus.SubscribeHTTP(); replacement == nil {
		t.Fatal("W02 failed to reclaim admission")
	} else {
		bus.Unsubscribe(replacement)
	}
	win156WaitSlots(t, bus, 0)
}

type win156FailedDeadlineWriter struct{ *httptest.ResponseRecorder }

func (w *win156FailedDeadlineWriter) SetWriteDeadline(time.Time) error {
	return errors.New("private synthetic socket failure")
}

// W03 is intentionally best-effort on the HTTP status: an actual broken
// connection may prevent any response. The synthetic writer is still usable.
func TestSSEWinNativeW03OtherDeadlineFailure(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	w := &win156FailedDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	(&Hub{bus: bus}).handleEventStream(w, httptest.NewRequest(http.MethodGet, win156Endpoint, nil))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "EVENTS_DEADLINE_FAILED") {
		t.Fatalf("W03 status=%d body=%q", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private synthetic") || strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatal("W03 leaked transport details or SSE success headers")
	}
	win156WaitSlots(t, bus, 0)
	if replacement := bus.SubscribeHTTP(); replacement == nil {
		t.Fatal("W03 failed to reclaim admission")
	} else {
		bus.Unsubscribe(replacement)
	}
	win156WaitSlots(t, bus, 0)
}

// W04 is an atomic, concurrently contended admission check, independent of
// scheduling or a real OS port. It cannot pass if capacity ever exceeds 64.
func TestSSEWinNativeW04ConcurrentCapacity64(t *testing.T) {
	bus := NewEventBus()
	defer bus.Close()
	const attempts = maxSSESubscribers * 3
	start := make(chan struct{})
	results := make(chan *eventSubscriber, attempts)
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- bus.SubscribeHTTP()
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var admitted []*eventSubscriber
	for sub := range results {
		if sub != nil {
			admitted = append(admitted, sub)
		}
	}
	if len(admitted) != maxSSESubscribers || qa135Subscribers(bus) != maxSSESubscribers {
		t.Fatalf("W04 admitted=%d live=%d, want exactly %d", len(admitted), qa135Subscribers(bus), maxSSESubscribers)
	}
	if bus.SubscribeHTTP() != nil {
		t.Fatal("W04 admitted subscriber above capacity")
	}
	for _, sub := range admitted {
		bus.Unsubscribe(sub)
	}
	win156WaitSlots(t, bus, 0)
}

// W05 uses genuine Windows loopback and explicit handler exit observation.
// Each subtest owns its bus/server and closes all clients before cleanup.
func TestSSEWinNativeW05DisconnectAndShutdown(t *testing.T) {
	for _, mode := range []string{"disconnect", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			bus := NewEventBus()
			handled := make(chan struct{}, 1)
			hub := (&Hub{bus: bus}).newHandler()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer func() { handled <- struct{}{} }()
				hub.ServeHTTP(w, r)
			}))
			t.Cleanup(func() { bus.Close(); srv.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+win156Endpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK || readSSE(t, bufio.NewReader(resp.Body), time.Second).name != "hello" {
				t.Fatalf("W05/%s missing SSE hello, HTTP %d", mode, resp.StatusCode)
			}
			win156WaitSlots(t, bus, 1)
			if mode == "shutdown" {
				bus.Close()
				// Verify the handler also finished, not just Close's immediate
				// clearing of the EventBus subscription map.
				win156WaitHandler(t, handled)
				win156WaitSlots(t, bus, 0)
				if bus.SubscribeHTTP() != nil {
					t.Fatal("W05/shutdown admitted subscriber after Close")
				}
			} else {
				cancel()
				resp.Body.Close()
				win156WaitHandler(t, handled)
				win156WaitSlots(t, bus, 0)
				if sub := bus.SubscribeHTTP(); sub == nil {
					t.Fatal("W05/disconnect slot not reusable")
				} else {
					bus.Unsubscribe(sub)
				}
				win156WaitSlots(t, bus, 0)
			}
		})
	}
}

// W06 does NOT touch Winsock. It uses a test-owned net.Pipe listener with
// zero peer-read buffering: after hello, a single 64 KiB synthetic event must
// block the handler's real net/http write. This separate deterministic test
// must not be reported as evidence for Windows TCP backpressure semantics.
type win156PipeAddr struct{}

func (win156PipeAddr) Network() string { return "sse-test-pipe" }
func (win156PipeAddr) String() string  { return "sse-test-owned" }

type win156PipeListener struct {
	pending chan net.Conn
	closed  chan struct{}
	once    sync.Once
}

func win156NewPipeListener() *win156PipeListener {
	return &win156PipeListener{pending: make(chan net.Conn), closed: make(chan struct{})}
}
func (l *win156PipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.pending:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}
func (l *win156PipeListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}
func (l *win156PipeListener) Addr() net.Addr { return win156PipeAddr{} }

type win156WriteResult struct {
	duration time.Duration
	err      error
}
type win156TrackedPipe struct {
	net.Conn
	helloWritten chan struct{}
	helloOnce    sync.Once
	started      chan time.Time
	result       chan win156WriteResult
	armed        atomic.Bool
	once         sync.Once
}

func (c *win156TrackedPipe) Write(p []byte) (int, error) {
	// net/http may send a chunk-size prefix in a separate transport write.
	// Arm only AFTER hello and immediately BEFORE the sole synthetic event:
	// the first subsequent underlying Write is the blocked event's write
	// path, regardless of whether its first bytes are a chunk header.
	if c.armed.Load() {
		start := time.Now()
		c.once.Do(func() { c.started <- start })
		n, err := c.Conn.Write(p)
		select {
		case c.result <- win156WriteResult{duration: time.Since(start), err: err}:
		default:
		}
		return n, err
	}
	n, err := c.Conn.Write(p)
	if err == nil && n == len(p) && bytes.Contains(p, []byte("event: hello\ndata: {}\n\n\r\n")) {
		// Confirm the complete transport Write carrying hello has returned.
		// Otherwise the next observed block could be the hello frame itself.
		c.helloOnce.Do(func() { close(c.helloWritten) })
	}
	return n, err
}

func (l *win156PipeListener) dialTracked() (net.Conn, *win156TrackedPipe, error) {
	server, client := net.Pipe()
	tracked := &win156TrackedPipe{
		Conn: server, helloWritten: make(chan struct{}), started: make(chan time.Time, 1), result: make(chan win156WriteResult, 1),
	}
	select {
	case l.pending <- tracked:
		return client, tracked, nil
	case <-l.closed:
		server.Close()
		client.Close()
		return nil, nil, net.ErrClosed
	case <-time.After(2 * time.Second):
		server.Close()
		client.Close()
		return nil, nil, errors.New("test-owned pipe server did not accept connection")
	}
}

func win156PipeRequest(t *testing.T, conn net.Conn) *http.Response {
	t.Helper()
	// net.Pipe has no kernel send buffering: the server must be accepting.
	if err := conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprint(conn, "GET "+win156Endpoint+" HTTP/1.1\r\nHost: sse-test-owned\r\nConnection: keep-alive\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetWriteDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("W06 HTTP status=%d, want 200", resp.StatusCode)
	}
	if frame := readSSE(t, bufio.NewReader(resp.Body), time.Second); frame.name != "hello" {
		t.Fatalf("W06 first frame=%q, want hello", frame.name)
	}
	// The post-hello client deliberately never reads again unless it is
	// the replacement client (which only reads its hello).
	return resp
}

// W06 asserts the *full* Hub handler, genuine blocked Write, timeout error,
// slot reclamation while the client stays connected, replacement HTTP hello,
// and subsequent replacement cleanup. No early peer close or bus shutdown.
func TestSSEWinNativeW06PipeBackpressureReclaimsHandler(t *testing.T) {
	bus := NewEventBus()
	for i := 0; i < maxSSESubscribers-1; i++ {
		if bus.SubscribeHTTP() == nil {
			t.Fatalf("W06 failed to reserve slot %d", i)
		}
	}
	listener := win156NewPipeListener()
	server := &http.Server{Handler: (&Hub{bus: bus}).newHandler()}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	var clients []net.Conn
	t.Cleanup(func() {
		// Cleanup is test-owned and runs even on t.Fatal. No other service,
		// network listener, or process is touched.
		bus.Close()
		for _, c := range clients {
			c.Close()
		}
		server.Close()
		listener.Close()
		select {
		case <-serveDone:
		case <-time.After(2 * time.Second):
			t.Error("W06 test-owned HTTP server did not stop")
		}
	})

	client, writer, err := listener.dialTracked()
	if err != nil {
		t.Fatal(err)
	}
	clients = append(clients, client)
	first := win156PipeRequest(t, client)
	defer first.Body.Close() // runs after assertions; NOT the recovery trigger
	select {
	case <-writer.helloWritten: // no unfinished hello transport Write may trigger the timeout proof
	case <-time.After(2 * time.Second):
		t.Fatal("W06 could not prove the hello transport write completed")
	}
	win156WaitSlots(t, bus, maxSSESubscribers)

	// Publish after receiving hello; its first unbuffered net.Pipe Write
	// must block because the client never reads the task event.
	writer.armed.Store(true)
	bus.Publish(eventTaskStarted, map[string]string{"synthetic": strings.Repeat("x", 64<<10)})
	select {
	case <-writer.started:
	case <-time.After(2 * time.Second):
		t.Fatal("W06 task event did not reach the underlying net.Conn.Write")
	}
	select {
	case result := <-writer.result:
		t.Fatalf("W06 write returned prematurely without backpressure: %+v", result)
	case <-time.After(250 * time.Millisecond):
	}
	if got := qa135Subscribers(bus); got != maxSSESubscribers {
		t.Fatalf("W06 slot left before deadline, got %d", got)
	}
	select {
	case outcome := <-writer.result:
		var timeout net.Error
		if !errors.As(outcome.err, &timeout) || !timeout.Timeout() {
			t.Fatalf("W06 blocked write returned non-timeout error: %+v", outcome)
		}
		if outcome.duration < sseWriteTimeout-500*time.Millisecond || outcome.duration > sseWriteTimeout+4*time.Second {
			t.Fatalf("W06 genuine write timed out in %s, expected near %s", outcome.duration, sseWriteTimeout)
		}
		t.Logf("W06 deterministic pipe write timed out in %s", outcome.duration)
	case <-time.After(sseWriteTimeout + 5*time.Second):
		t.Fatal("W06 full-handler write did not return by deadline + 5s")
	}
	// Client was never closed and bus was never shut down. The only
	// permitted cleanup mechanism here was the server's write timeout.
	win156WaitSlots(t, bus, maxSSESubscribers-1)

	nextClient, _, err := listener.dialTracked()
	if err != nil {
		t.Fatal(err)
	}
	clients = append(clients, nextClient)
	next := win156PipeRequest(t, nextClient)
	if got := qa135Subscribers(bus); got != maxSSESubscribers {
		t.Fatalf("W06 replacement did not occupy last slot: %d", got)
	}
	next.Body.Close()
	nextClient.Close()
	win156WaitSlots(t, bus, maxSSESubscribers-1)
}
