package openai

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	"github.com/tidwall/gjson"
)

type piCloudTestRequest struct {
	connection int64
	body       []byte
}
type piCloudModelFixture struct {
	handler     *OpenAIResponsesAPIHandler
	server      *httptest.Server
	received    chan piCloudTestRequest
	connections atomic.Int64
	block       atomic.Bool
	tool        atomic.Bool
	turns       atomic.Int64
	missing     atomic.Bool
	closeFirst  atomic.Bool
	httpCalls   atomic.Int64
	peersMu     sync.Mutex
	peers       []*websocket.Conn
}

func piCloudFixture(t *testing.T) *piCloudModelFixture {
	t.Helper()
	f := &piCloudModelFixture{received: make(chan piCloudTestRequest, 32)}
	upgrade := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !websocket.IsWebSocketUpgrade(r) {
			f.httpCalls.Add(1)
			body, _ := io.ReadAll(r.Body)
			f.received <- piCloudTestRequest{0, body}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_http\",\"status\":\"in_progress\"}}\n\n")
			fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n")
			return
		}
		conn, err := upgrade.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		id := f.connections.Add(1)
		f.peersMu.Lock()
		f.peers = append(f.peers, conn)
		f.peersMu.Unlock()
		for {
			_, b, err := conn.ReadMessage()
			if err != nil {
				return
			}
			f.received <- piCloudTestRequest{id, b}
			if f.closeFirst.CompareAndSwap(true, false) {
				return
			}
			if gjson.GetBytes(b, "previous_response_id").Exists() && f.missing.CompareAndSwap(true, false) {
				conn.WriteJSON(map[string]any{"type": "error", "status": 400, "error": map[string]any{"code": "previous_response_not_found", "message": "expired"}})
				continue
			}
			if f.block.Load() {
				continue
			}
			item := map[string]any{"type": "message", "role": "assistant", "id": "msg_ok", "status": "completed", "phase": "final_answer", "content": []any{map[string]any{"type": "output_text", "text": "OK", "annotations": []any{}}}}
			if f.tool.Load() && f.turns.Add(1) == 1 {
				item = map[string]any{"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "read", "arguments": "{\"path\":\"a.png\"}", "status": "completed"}
			}
			for _, frame := range []any{
				map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_ok", "status": "in_progress"}},
				map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item},
				map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item},
				map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp_ok", "status": "completed", "output": []any{item}, "usage": map[string]any{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
			} {
				if err := conn.WriteJSON(frame); err != nil {
					return
				}
			}
		}
	}))
	manager := coreauth.NewManager(nil, nil, nil)
	cfg := &config.Config{SDKConfig: config.SDKConfig{DisableImageGeneration: config.DisableImageGenerationAll}}
	manager.RegisterExecutor(executor.NewCodexAutoExecutor(cfg))
	auth := &coreauth.Auth{ID: uuid.NewString(), Provider: "codex", Status: coreauth.StatusActive, Attributes: map[string]string{"api_key": "fixture-key", "base_url": upstream.URL, "websockets": "true"}}
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatal(err)
	}
	registry.GetGlobalRegistry().RegisterClient(auth.ID, "codex", []*registry.ModelInfo{{ID: "test-model"}})
	f.handler = NewOpenAIResponsesAPIHandler(handlers.NewBaseAPIHandlers(&cfg.SDKConfig, manager))
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/v1/picloud/responses", f.handler.PiCloudResponses)
	router.POST("/codex/responses", f.handler.PiCloudResponses)
	f.server = httptest.NewServer(router)
	t.Cleanup(func() {
		if p := f.handler.piCloud.pool; p != nil {
			p.mu.Lock()
			for _, s := range p.entries {
				p.removeLocked(s)
			}
			p.mu.Unlock()
		}
		f.peersMu.Lock()
		for _, c := range f.peers {
			c.Close()
		}
		f.peersMu.Unlock()
		f.server.Close()
		upstream.Close()
		registry.GetGlobalRegistry().UnregisterClient(auth.ID)
	})
	return f
}

func TestPiCloudModelNativePi(t *testing.T) {
	root := os.Getenv("PI_CLOUD_SOURCE_ROOT")
	if root == "" {
		t.Skip("native Pi contract runs from PiCloud source checkout")
	}
	f := piCloudFixture(t)
	f.tool.Store(true)
	history := filepath.Join(t.TempDir(), "synthetic-history.json")
	for _, mode := range []string{"first", "second"} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		command := exec.CommandContext(ctx, "node", "--import", "tsx", filepath.Join(root, "scripts/lib/provider-model-native-fixture.mjs"), f.server.URL, history, mode)
		command.Dir = root
		result, err := command.CombinedOutput()
		cancel()
		if err != nil {
			t.Fatalf("native Pi %s: %v %s", mode, err, result)
		}
	}
	first, tool, next := <-f.received, <-f.received, <-f.received
	if first.connection != tool.connection || tool.connection != next.connection {
		t.Fatal("native clients did not reuse upstream")
	}
	if gjson.GetBytes(tool.body, "previous_response_id").String() == "" || len(gjson.GetBytes(tool.body, "input").Array()) != 1 {
		t.Fatal("Tool result did not use a delta")
	}
	if gjson.GetBytes(next.body, "previous_response_id").String() == "" || bytes.Contains(next.body, []byte("base64")) {
		t.Fatal("cold native client retransmitted images")
	}
}

func piCloudBody(input string) string {
	return `{"model":"test-model","store":false,"stream":true,"instructions":"test","input":` + input + `}`
}

const piCloudUser = `{"role":"user","content":[{"type":"input_text","text":"hello"}]}`
const piCloudAnswer = `{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}],"status":"completed","id":"msg_ok","phase":"final_answer"}`

func (f *piCloudModelFixture) send(t *testing.T, body string, key string) string {
	t.Helper()
	req, _ := http.NewRequest("POST", f.server.URL+"/v1/picloud/responses", strings.NewReader(body))
	req.Header.Set("X-PiCloud-Model-Session", key)
	req.Header.Set("Authorization", "Bearer fixture")
	client := &http.Client{Timeout: 10 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || !bytes.Contains(b, []byte(`"response.completed"`)) {
		t.Fatalf("status=%d result=%s", res.StatusCode, b)
	}
	return string(b)
}

func TestPiCloudModelCrossClientContinuation(t *testing.T) {
	f := piCloudFixture(t)
	key := strings.Repeat("a", 64)
	first := piCloudBody("[" + piCloudUser + "]")
	f.send(t, first, key)
	a := <-f.received
	// Different HTTP clients and request lifetimes represent two Worker owners.
	f.send(t, piCloudBody("["+piCloudUser+","+piCloudAnswer+","+piCloudUser+"]"), key)
	b := <-f.received
	if a.connection != b.connection {
		t.Fatal("completed client closed the upstream connection")
	}
	if gjson.GetBytes(b.body, "previous_response_id").String() != "resp_ok" || len(gjson.GetBytes(b.body, "input").Array()) != 1 {
		t.Fatalf("expected delta: %s", b.body)
	}
	// A shortened/edited context must not inherit a previously completed result.
	f.send(t, first, key)
	c := <-f.received
	if c.connection == b.connection || gjson.GetBytes(c.body, "previous_response_id").Exists() {
		t.Fatal("context replacement used stale continuation")
	}
	// Another Conversation has its own connection and baseline.
	f.send(t, first, strings.Repeat("b", 64))
	d := <-f.received
	if d.connection == c.connection {
		t.Fatal("Conversation scopes share a socket")
	}
}

func TestPiCloudModelCancelAndExpiry(t *testing.T) {
	f := piCloudFixture(t)
	key := strings.Repeat("c", 64)
	f.block.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/v1/picloud/responses", strings.NewReader(piCloudBody("["+piCloudUser+"]")))
	req.Header.Set("X-PiCloud-Model-Session", key)
	req.Header.Set("Authorization", "Bearer fixture")
	returned := make(chan error, 1)
	go func() {
		r, e := http.DefaultClient.Do(req)
		if r != nil {
			r.Body.Close()
		}
		returned <- e
	}()
	first := <-f.received
	cancel()
	<-returned
	deadline := time.Now().Add(3 * time.Second)
	for {
		p := f.handler.piCloud.pool
		p.mu.Lock()
		n := len(p.entries)
		p.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel retained upstream")
		}
		time.Sleep(time.Millisecond)
	}
	f.block.Store(false)
	f.send(t, piCloudBody("["+piCloudUser+"]"), key)
	second := <-f.received
	if second.connection == first.connection {
		t.Fatal("cancelled connection reused")
	}
	p := f.handler.piCloud.pool
	p.mu.Lock()
	for _, s := range p.entries {
		s.used = time.Now().Add(-time.Hour)
	}
	p.mu.Unlock()
	f.send(t, piCloudBody("["+piCloudUser+","+piCloudAnswer+","+piCloudUser+"]"), key)
	third := <-f.received
	if third.connection == second.connection || gjson.GetBytes(third.body, "previous_response_id").Exists() {
		t.Fatal("expired baseline reused")
	}
}

func TestPiCloudModelMissingResponseRebuildsOnce(t *testing.T) {
	f := piCloudFixture(t)
	key := strings.Repeat("d", 64)
	f.send(t, piCloudBody("["+piCloudUser+"]"), key)
	first := <-f.received
	f.missing.Store(true)
	f.send(t, piCloudBody("["+piCloudUser+","+piCloudAnswer+","+piCloudUser+"]"), key)
	delta, rebuild := <-f.received, <-f.received
	if first.connection != delta.connection || first.connection == rebuild.connection || gjson.GetBytes(rebuild.body, "previous_response_id").Exists() || len(gjson.GetBytes(rebuild.body, "input").Array()) != 3 {
		t.Fatal("missing continuation did not rebuild from complete caller context")
	}
}

func TestPiCloudModelPreOutputHTTPFallback(t *testing.T) {
	f := piCloudFixture(t)
	f.closeFirst.Store(true)
	key := strings.Repeat("f", 64)
	f.send(t, piCloudBody("["+piCloudUser+"]"), key)
	ws, http := <-f.received, <-f.received
	if ws.connection == 0 || http.connection != 0 || f.httpCalls.Load() != 1 {
		t.Fatal("no single HTTP fallback")
	}
	f.send(t, piCloudBody("["+piCloudUser+"]"), key)
	next := <-f.received
	if next.connection != 0 || gjson.GetBytes(next.body, "previous_response_id").Exists() {
		t.Fatal("fallback must send full input without retrying a known-broken websocket each step")
	}
}

func TestPiCloudModelFingerprints(t *testing.T) {
	a, e := piCloudItemDigest([]byte(`{"type":"function_call","status":"completed","id":"fc_1","name":"read","call_id":"call_1","arguments":"{\"b\":2,\"a\":1}"}`))
	if e != nil {
		t.Fatal(e)
	}
	b, e := piCloudItemDigest([]byte(`{"call_id":"call_1","name":"read","id":"fc_1","arguments":"{\"a\":1, \"b\":2}","type":"function_call"}`))
	if e != nil || a != b {
		t.Fatal("Pi argument serialization must preserve continuation")
	}
	c, _ := piCloudItemDigest([]byte(`{"call_id":"call_1","name":"read","id":"fc_1","arguments":"{\"a\":9,\"b\":2}","type":"function_call"}`))
	if c == b {
		t.Fatal("changed args considered equal")
	}
}

func TestPiCloudModelBodyBounds(t *testing.T) {
	for _, test := range []struct {
		name, body, encoding, want string
		limit                      int64
	}{
		{"plain", `{"ok":true}`, "", "", 32},
		{"oversize", strings.Repeat("x", 33), "", "request_too_large", 32},
		{"bad-zstd", "invalid", "zstd", "invalid_request_encoding", 1024},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/", strings.NewReader(test.body))
			c.Request.Header.Set("Content-Encoding", test.encoding)
			_, code := piCloudReadBody(c, test.limit)
			if code != test.want {
				t.Fatalf("%s != %s", code, test.want)
			}
		})
	}
	encoder, _ := zstd.NewWriter(nil)
	defer encoder.Close()
	payload := bytes.Repeat([]byte("x"), 129*piCloudMiB)
	compressed := encoder.EncodeAll(payload, nil)
	payload = nil
	for _, limit := range []int64{128 * piCloudMiB, 256 * piCloudMiB} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/", bytes.NewReader(compressed))
		c.Request.Header.Set("Content-Encoding", "zstd")
		body, code := piCloudReadBody(c, limit)
		if limit == 128*piCloudMiB && code != "request_too_large" {
			t.Fatal(code)
		}
		if limit == 256*piCloudMiB && (code != "" || len(body) != 129*piCloudMiB) {
			t.Fatalf("large decode: %d %s", len(body), code)
		}
	}
}

func TestPiCloudModelPoolBoundsAndLateCleanup(t *testing.T) {
	var closed []string
	p := newPiCloudModelSessions(func(id string) { closed = append(closed, id) })
	p.maxEntries = 1
	p.maxInFlight = 100
	a, _ := p.acquire("a")
	if _, e := p.acquire("a"); e == nil {
		t.Fatal("overlap accepted")
	}
	if _, e := p.acquire("b"); e == nil {
		t.Fatal("active evicted")
	}
	p.finish(a, true)
	b, _ := p.acquire("b")
	p.finish(a, false)
	if p.entries["b"] != b || len(closed) != 1 {
		t.Fatal("late cleanup removed replacement")
	}
	p.finish(b, false)
	if !p.reserve(90) || p.reserve(11) || !p.reserve(-90) || p.inFlight != 0 {
		t.Fatal("upload admission broken")
	}
	_ = fmt.Sprintf("%v", closed)
}
