package picloudmetering

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/base64"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/runtime/executor/helps"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

func testAttribution() attribution {
	n := int64(3)
	return attribution{Version: 1, InvocationID: uuid.NewString(), TenantID: uuid.NewString(), SessionID: uuid.NewString(), RunID: uuid.NewString(), RequestedAt: "2026-11-06T08:00:00.000Z", PiSessionID: "native-session", ConversationID: &n, Provider: "openai-codex", Model: "gpt-6-luna", Purpose: "agent"}
}
func readEvents(t *testing.T, j *journal) []event {
	t.Helper()
	batch, err := j.batch()
	if err != nil {
		t.Fatal(err)
	}
	var events []event
	for _, item := range batch {
		var e event
		if err = json.Unmarshal(item.raw, &e); err != nil {
			t.Fatal(err)
		}
		events = append(events, e)
	}
	return events
}

func TestDeliveryEvidenceIsAuthenticatedReadOnlyAndRetainsPendingWork(t *testing.T) {
	path := filepath.Join(t.TempDir(), "delivery.bolt")
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer receiver.Close()
	s := New(Options{Path: path, Endpoint: receiver.URL, Token: "owned-delivery-key"})
	defer s.Close()
	router := gin.New()
	router.GET("/internal/picloud/metering/delivery", s.Delivery())
	read := func(token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/internal/picloud/metering/delivery", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		return response
	}
	if response := read("wrong"); response.Code != http.StatusUnauthorized {
		t.Fatal("delivery evidence exposed without source credential", response.Code)
	}
	if response := read("owned-delivery-key"); response.Code != http.StatusServiceUnavailable {
		t.Fatal("uninitialized source reported delivery completion", response.Code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("read-only evidence initialized the source journal", err)
	}
	if !s.Ready() {
		t.Fatal("owned source did not initialize")
	}
	var state struct {
		Version         int    `json:"version"`
		BootID          string `json:"bootId"`
		Pending         int    `json:"pending"`
		Active          int    `json:"active"`
		CaptureFailures uint64 `json:"captureFailures"`
	}
	check := func(pending, active int) {
		t.Helper()
		response := read("owned-delivery-key")
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil {
			t.Fatal("delivery state unavailable", response.Code)
		}
		if state.Version != 1 || state.BootID != s.bootID || state.Pending != pending || state.Active != active {
			t.Fatalf("incorrect bounded delivery state: %+v", state)
		}
		if strings.Contains(response.Body.String(), "owned-delivery-key") {
			t.Fatal("delivery state exposed credentials")
		}
	}
	check(0, 0)
	a := testAttribution()
	if err := s.journal.admit(a); err != nil {
		t.Fatal(err)
	}
	check(1, 1)
	if err := s.journal.append(event{Kind: "finished", Context: a, OccurredAt: timestamp(time.Now())}); err != nil {
		t.Fatal(err)
	}
	check(2, 0)
	batch, err := s.journal.batch()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.journal.acknowledge(batch); err != nil {
		t.Fatal(err)
	}
	check(0, 0)
	if err := s.journal.db.Close(); err != nil {
		t.Fatal(err)
	}
	(&requestCapture{journal: s.journal, context: a}).append(event{Kind: "usage", Context: a})
	if s.journal.captureFailures.Load() != 1 {
		t.Fatal("capture failure was not exposed to delivery evidence")
	}
	if response := read("owned-delivery-key"); response.Code != http.StatusServiceUnavailable {
		t.Fatal("closed journal reported successful delivery", response.Code)
	}
}
func TestMeteringRecoveryAndCapacity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipts.bolt")
	j, err := openJournal(path, 65536)
	if err != nil {
		t.Fatal(err)
	}
	a := testAttribution()
	if err = j.admit(a); err != nil {
		t.Fatal(err)
	}
	if err = j.admit(testAttribution()); err != errCapacity {
		t.Fatalf("expected admission backpressure: %v", err)
	}
	c := &requestCapture{journal: j, context: a}
	c.AttemptStarted(uuid.NewString(), time.Now())
	if err = j.db.Close(); err != nil {
		t.Fatal(err)
	}
	j, err = openJournal(path, 65536)
	if err != nil {
		t.Fatal(err)
	}
	defer j.db.Close()
	events := readEvents(t, j)
	if len(events) != 3 {
		t.Fatalf("recovery receipts: %+v", events)
	}
	found := false
	for _, e := range events {
		found = found || e.Kind == "interrupted"
	}
	if !found {
		t.Fatal("missing interrupted receipt")
	}
	batch, _ := j.batch()
	if err = j.acknowledge(batch); err != nil {
		t.Fatal(err)
	}
	if err = j.admit(testAttribution()); err != nil {
		t.Fatalf("capacity did not recover: %v", err)
	}
}
func TestMeteringLostAckReplaysOnlyReceipts(t *testing.T) {
	j, err := openJournal(filepath.Join(t.TempDir(), "receipts.bolt"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer j.db.Close()
	a := testAttribution()
	if err = j.admit(a); err != nil {
		t.Fatal(err)
	}
	calls := 0
	var first string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer receipt-only-key" {
			t.Error("missing receipt authorization")
		}
		var body struct {
			Events []json.RawMessage `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		calls++
		if calls == 1 {
			first = string(body.Events[0])
			w.WriteHeader(503)
			return
		}
		if first != string(body.Events[0]) {
			t.Error("receipt identity changed on retry")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":1}`))
	}))
	defer server.Close()
	s := New(Options{Endpoint: server.URL, Token: "receipt-only-key"})
	if err = s.flush(context.Background(), j); err == nil {
		t.Fatal("ack loss was accepted")
	}
	if len(readEvents(t, j)) != 1 {
		t.Fatal("unacknowledged receipt discarded")
	}
	if err = s.flush(context.Background(), j); err != nil {
		t.Fatal(err)
	}
	if len(readEvents(t, j)) != 0 || calls != 2 {
		t.Fatal("receipt not collected after ack")
	}
}
func TestMeteringCapturesBeforeAsyncQueueAndCopiesRequestIdentity(t *testing.T) {
	gin.SetMode(gin.TestMode)
	s := New(Options{Path: filepath.Join(t.TempDir(), "receipts.bolt"), Endpoint: "http://127.0.0.1:1", Token: "private"})
	defer s.Close()
	router := gin.New()
	router.Use(s.Middleware())
	var saved context.Context
	var releaseSaved func()
	router.POST("/v1/responses", func(c *gin.Context) {
		if releaseSaved != nil {
			releaseSaved()
		}
		if c.GetHeader(Header) != "" {
			t.Error("internal attribution forwarded")
		}
		ctx := usage.InheritCapture(context.Background(), c.Request.Context())
		reporter := helps.NewUsageReporter(ctx, "codex", "gpt-6-luna", nil)
		reporter.Publish(ctx, usage.Detail{InputTokens: 100, OutputTokens: 30, ReasoningTokens: 10, CachedTokens: 40, CacheReadTokens: 40, TotalTokens: 130})
		// Publication must already be durable even if no asynchronous usage plugin runs.
		j, _ := s.open()
		found := false
		for _, e := range readEvents(t, j) {
			if e.Kind == "usage" && e.ExecutionID == reporter.RequestID() {
				found = true
			}
		}
		if !found {
			t.Error("source capture deferred until asynchronous dispatch")
		}
		saved = ctx
		releaseSaved = usage.RetainProducer(ctx)
		c.Status(200)
	})
	a, b := testAttribution(), testAttribution()
	b.SessionID = a.SessionID
	b.PiSessionID = a.PiSessionID
	for _, ctx := range []attribution{a, b} {
		raw, _ := json.Marshal(ctx)
		req := httptest.NewRequest("POST", "/v1/responses", nil)
		req.Header.Set(Header, base64.RawURLEncoding.EncodeToString(raw))
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatal(rec.Code)
		}
	}
	// A callback after Gin has released its request still uses the copied context.
	usage.CaptureFromContext(saved).Record(usage.Record{RequestID: uuid.NewString(), Provider: "codex", Model: "gpt-6-luna", RequestedAt: time.Now(), Failed: true, APIKey: "SECRET", Fail: usage.Failure{Body: "PRIVATE PROMPT"}, Detail: usage.Detail{InputTokens: 5, TotalTokens: 5}})
	releaseSaved()
	j, _ := s.open()
	events := readEvents(t, j)
	counts := map[string]int{}
	for _, e := range events {
		if e.Kind == "usage" {
			counts[e.Context.RunID]++
			if e.Usage.Tokens.Total == 130 && (e.Usage.Tokens.Input != 60 || e.Usage.Tokens.Output != 20 || e.Usage.Tokens.Reasoning != 10) {
				t.Fatalf("overlapping tokens: %+v", e.Usage)
			}
		}
	}
	if counts[a.RunID] != 1 || counts[b.RunID] != 2 {
		t.Fatalf("cross-run attribution: %v", counts)
	}
	raw, _ := json.Marshal(events)
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), "PRIVATE PROMPT") {
		t.Fatal("secret captured")
	}
}

func TestMeteringFinishedWaitsForLateMainAndAdditionalUsage(t *testing.T) {
	j, err := openJournal(filepath.Join(t.TempDir(), "late.bolt"), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer j.db.Close()
	a := testAttribution()
	if err := j.admit(a); err != nil {
		t.Fatal(err)
	}
	capture := &requestCapture{journal: j, context: a}
	ctx := usage.WithCapture(context.Background(), capture)
	release := usage.RetainProducer(ctx)
	reporter := helps.NewUsageReporter(ctx, "codex", a.Model, nil)
	cancelled := true
	capture.finish(event{Kind: "finished", Context: a, OccurredAt: timestamp(time.Now()), StatusCode: 200, Cancelled: &cancelled})
	for _, e := range readEvents(t, j) {
		if e.Kind == "finished" {
			t.Fatal("HTTP completion released a still-publishing invocation")
		}
	}
	reporter.Publish(ctx, usage.Detail{InputTokens: 10, OutputTokens: 2, TotalTokens: 12})
	state, err := j.deliveryState()
	if err != nil || state.active == 0 {
		t.Fatal("main usage falsely closed additional publication", err)
	}
	reporter.PublishAdditionalModel(ctx, "owned-secondary", usage.Detail{InputTokens: 3, OutputTokens: 1, TotalTokens: 4})
	release()
	release()
	state, err = j.deliveryState()
	if err != nil || state.active != 0 || state.pending == 0 {
		t.Fatalf("late capture did not settle: %+v %v", state, err)
	}
	counts := map[string]int{}
	for _, e := range readEvents(t, j) {
		counts[e.Kind]++
	}
	if counts["usage"] != 2 || counts["finished"] != 1 || j.captureFailures.Load() != 0 {
		t.Fatalf("late source facts were dropped, duplicated or misclassified: %v", counts)
	}
	batch, err := j.batch()
	if err != nil {
		t.Fatal(err)
	}
	if err := j.acknowledge(batch); err != nil {
		t.Fatal(err)
	}
	state, err = j.deliveryState()
	if err != nil || state.active != 0 || state.pending != 0 {
		t.Fatal("acknowledged source did not drain", err)
	}
}

func TestMeteringPublisherCrashKeepsExistingActiveJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "publisher-crash.bolt")
	j, err := openJournal(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	a := testAttribution()
	if err := j.admit(a); err != nil {
		t.Fatal(err)
	}
	capture := &requestCapture{journal: j, context: a}
	_ = capture.RetainProducer() // Lost with this source process.
	capture.finish(event{Kind: "finished", Context: a, OccurredAt: timestamp(time.Now()), StatusCode: 200})
	if err := j.db.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := openJournal(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.db.Close()
	counts := map[string]int{}
	for _, e := range readEvents(t, restored) {
		counts[e.Kind]++
	}
	if counts["started"] != 1 || counts["interrupted"] != 1 || counts["finished"] != 0 {
		t.Fatalf("publisher crash invented completion or replay: %v", counts)
	}
}
func TestMeteringUnavailableRejectsBeforeModelExecution(t *testing.T) {
	s := New(Options{Path: filepath.Join(t.TempDir(), "receipts.bolt"), Endpoint: "bad", Token: "key"})
	defer s.Close()
	router := gin.New()
	router.Use(s.Middleware())
	called := false
	router.POST("/v1/responses", func(c *gin.Context) { called = true })
	raw, _ := json.Marshal(testAttribution())
	req := httptest.NewRequest("POST", "/v1/responses", nil)
	req.Header.Set(Header, base64.RawURLEncoding.EncodeToString(raw))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 503 || called {
		t.Fatal("unrecordable model admitted")
	}
}

func TestMeteringUncleanExit(t *testing.T) {
	if path := os.Getenv("PI_CLOUD_METERING_CRASH_FIXTURE"); path != "" {
		j, err := openJournal(path, 1<<20)
		if err != nil {
			os.Exit(74)
		}
		a := testAttribution()
		if j.admit(a) != nil {
			os.Exit(75)
		}
		(&requestCapture{journal: j, context: a}).AttemptStarted(uuid.NewString(), time.Now())
		os.Exit(73) // Deliberately bypass Close and all deferred cleanup after fsync.
	}
	path := filepath.Join(t.TempDir(), "unclean.bolt")
	cmd := exec.Command(os.Args[0], "-test.run=^TestMeteringUncleanExit$")
	cmd.Env = append(os.Environ(), "PI_CLOUD_METERING_CRASH_FIXTURE="+path)
	err := cmd.Run()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 73 {
		t.Fatalf("unexpected fixture exit: %v", err)
	}
	j, err := openJournal(path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer j.db.Close()
	events := readEvents(t, j)
	if len(events) != 3 {
		t.Fatalf("durable starts missing after unclean exit: %d", len(events))
	}
	interrupted := false
	for _, e := range events {
		interrupted = interrupted || e.Kind == "interrupted"
	}
	if !interrupted {
		t.Fatal("lost incomplete admission")
	}
}

func TestMeteringOptionalZeroDimensionsAreTextUsage(t *testing.T) {
	zero, one := int64(0), int64(1)
	seconds := float64(0)
	detail := usage.Detail{InputTokens: 20, OutputTokens: 7, TotalTokens: 27, ImageCount: &zero, WebSearchRequests: &zero, AudioInputTokens: &zero, AudioOutputTokens: &zero, VideoInputTokens: &zero,
		MediaCounts:      &usage.MediaCounts{PromptMedia: &zero, CompletionMedia: &zero, PromptAudio: &zero, AudioSeconds: &seconds},
		ToolUsageDetails: &usage.ToolUsageDetails{WebSearchCalls: &zero, NumServerSideToolsUsed: &zero, ToolCallsRequested: &one, ToolCallsExecuted: &zero, Extra: map[string]int64{"future_counter": 0}}}
	if hasUnsupportedDimensions(detail) {
		t.Fatal("zero metadata/local function call was billed as a hosted dimension")
	}
	detail.ToolUsageDetails.ToolCallsExecuted = &one
	if !hasUnsupportedDimensions(detail) {
		t.Fatal("provider-reported execution needs an explicit tariff")
	}
	detail.ToolUsageDetails.ToolCallsExecuted = &zero
	detail.ToolUsageDetails.WebSearchCalls = &one
	if !hasUnsupportedDimensions(detail) {
		t.Fatal("hosted search needs an explicit tariff")
	}
	detail.ToolUsageDetails.WebSearchCalls = &zero
	detail.ToolUsageDetails.Extra["future_counter"] = 1
	if !hasUnsupportedDimensions(detail) {
		t.Fatal("unknown nonzero hosted dimension must remain unpriced")
	}
	detail.ToolUsageDetails = nil
	detail.MediaCounts.CompletionMedia = &one
	if !hasUnsupportedDimensions(detail) {
		t.Fatal("generated media needs an explicit tariff")
	}
}
