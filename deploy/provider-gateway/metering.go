// Package picloudmetering durably hands sanitized provider usage to PiCloud.
// It owns neither model execution nor prices and never retries model work.
package picloudmetering

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"encoding/json"
	"github.com/MoeForge/moego/base64"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
)

const Header = "X-Picloud-Metering"

type attribution struct {
	Version        int    `json:"version"`
	InvocationID   string `json:"invocationId"`
	TenantID       string `json:"tenantId"`
	SessionID      string `json:"sessionId"`
	RunID          string `json:"runId"`
	RequestedAt    string `json:"requestedAt"`
	PiSessionID    string `json:"piSessionId,omitempty"`
	ConversationID *int64 `json:"conversationId,omitempty"`
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	Purpose        string `json:"purpose"`
	OperationID    string `json:"operationId,omitempty"`
}
type tokens struct {
	Input        int64 `json:"input"`
	CacheRead    int64 `json:"cacheRead"`
	CacheWrite   int64 `json:"cacheWrite"`
	Output       int64 `json:"output"`
	Reasoning    int64 `json:"reasoning"`
	Unclassified int64 `json:"unclassified"`
	Total        int64 `json:"total"`
}
type fact struct {
	Model                 string `json:"model"`
	Provider              string `json:"provider"`
	ServiceTier           string `json:"serviceTier"`
	Failed                bool   `json:"failed"`
	Quality               string `json:"quality"`
	Tokens                tokens `json:"tokens"`
	ImageCount            *int64 `json:"imageCount,omitempty"`
	WebSearchRequests     *int64 `json:"webSearchRequests,omitempty"`
	UnsupportedDimensions bool   `json:"unsupportedDimensions"`
}
type event struct {
	Context     attribution `json:"context"`
	Kind        string      `json:"kind"`
	OccurredAt  string      `json:"occurredAt"`
	ExecutionID string      `json:"executionId,omitempty"`
	Usage       *fact       `json:"usage,omitempty"`
	StatusCode  int         `json:"statusCode,omitempty"`
	Cancelled   *bool       `json:"cancelled,omitempty"`
}

func timestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func parseAttribution(raw string) (attribution, error) {
	var a attribution
	if len(raw) > 4096 {
		return a, errors.New("metering context too large")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return a, err
	}
	if err = json.Unmarshal(b, &a); err != nil {
		return a, err
	}
	for _, id := range []string{a.InvocationID, a.TenantID, a.SessionID, a.RunID} {
		if _, err = uuid.Parse(id); err != nil {
			return a, err
		}
	}
	if a.Version != 1 || len(a.Provider) == 0 || len(a.Provider) > 256 || len(a.Model) == 0 || len(a.Model) > 256 || len(a.PiSessionID) > 256 || len(a.OperationID) > 256 {
		return a, errors.New("invalid metering identity")
	}
	if a.Purpose != "agent" && a.Purpose != "context_maintenance" && a.Purpose != "image" {
		return a, errors.New("invalid metering purpose")
	}
	if a.ConversationID != nil && (*a.ConversationID < 0 || *a.ConversationID > 9007199254740991) {
		return a, errors.New("invalid conversation")
	}
	t, err := time.Parse(time.RFC3339Nano, a.RequestedAt)
	if err != nil {
		return a, err
	}
	a.RequestedAt = timestamp(t)
	return a, nil
}

type Options struct {
	Path, Endpoint, Token string
	Capacity              int64
	Client                *http.Client
}
type Service struct {
	options Options
	mu      sync.Mutex
	journal *journal
	closed  bool
	cancel  context.CancelFunc
	done    chan struct{}
}

func New(options Options) *Service {
	if options.Capacity <= 0 {
		options.Capacity = 64 * 1024 * 1024
	}
	if options.Client == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		options.Client = &http.Client{Transport: transport, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Service{options: options}
}
func NewFromEnvironment() *Service {
	path := os.Getenv("PI_CLOUD_METERING_PATH")
	if path == "" {
		return nil
	}
	key, _ := os.ReadFile(os.Getenv("PI_CLOUD_METERING_KEY_FILE"))
	return New(Options{Path: path, Endpoint: os.Getenv("PI_CLOUD_METERING_URL"), Token: strings.TrimSpace(string(key))})
}
func (s *Service) open() (*journal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("metering closed")
	}
	if s.journal != nil {
		return s.journal, nil
	}
	u, err := url.Parse(s.options.Endpoint)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || s.options.Token == "" {
		return nil, errors.New("invalid metering delivery configuration")
	}
	j, err := openJournal(s.options.Path, s.options.Capacity)
	if err != nil {
		return nil, err
	}
	s.journal = j
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.done = make(chan struct{})
	go func() { defer close(s.done); s.deliver(ctx, j) }()
	return j, nil
}
func (s *Service) Ready() bool {
	if s == nil {
		return true
	}
	_, err := s.open()
	return err == nil
}
func (s *Service) Close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	j := s.journal
	cancel := s.cancel
	done := s.done
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	if j != nil {
		_ = j.db.Close()
	}
}
func (s *Service) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := c.GetHeader(Header)
		if raw == "" {
			c.Next()
			return
		} // Non-PiCloud CPA clients have no cloud account attribution.
		c.Request.Header.Del(Header) // Never forward internal ownership to the provider.
		if s == nil {
			c.AbortWithStatusJSON(503, gin.H{"error": "model_metering_unavailable"})
			return
		}
		a, err := parseAttribution(raw)
		if err != nil {
			c.AbortWithStatusJSON(400, gin.H{"error": "invalid_model_metering_context"})
			return
		}
		j, err := s.open()
		if err == nil {
			err = j.admit(a)
		}
		if err != nil {
			c.AbortWithStatusJSON(503, gin.H{"error": "model_metering_unavailable"})
			return
		}
		capture := &requestCapture{journal: j, context: a}
		c.Request = c.Request.WithContext(usage.WithCapture(c.Request.Context(), capture))
		defer func() {
			cancelled := c.Request.Context().Err() != nil
			capture.append(event{Kind: "finished", Context: a, OccurredAt: timestamp(time.Now()), StatusCode: c.Writer.Status(), Cancelled: &cancelled})
		}()
		c.Next()
	}
}

type requestCapture struct {
	journal *journal
	context attribution
}

func (r *requestCapture) append(e event) {
	if err := r.journal.append(e); err != nil {
		log.WithField("invocationId", r.context.InvocationID).Error("picloud.metering.capture_failed")
	}
}
func (r *requestCapture) AttemptStarted(id string, at time.Time) {
	r.append(event{Kind: "attempt", Context: r.context, ExecutionID: id, OccurredAt: timestamp(at)})
}
func (r *requestCapture) Record(record usage.Record) {
	d := usage.EnsureTokenBreakdownForProvider(record.Detail, record.Provider, record.ExecutorType)
	b := d.TokenBreakdown
	model := record.ResponseModel
	if model == "" {
		model = record.Model
	}
	tier := record.ResponseServiceTier
	if tier == "" {
		tier = record.EffectiveServiceTier
	}
	if tier == "" {
		tier = record.ServiceTier
	}
	if tier == "" {
		tier = "default"
	}
	quality := string(b.Quality)
	if b.TotalTokens == 0 {
		quality = "unclassified"
	} // EnsurePublished also synthesizes empty usage.
	f := &fact{Model: model, Provider: record.Provider, ServiceTier: tier, Failed: record.Failed, Quality: quality,
		Tokens:     tokens{b.Input.UncachedTokens, b.Input.CacheReadTokens, b.Input.CacheWriteTokens, b.Output.NonReasoningTokens, b.Output.ReasoningTokens, b.UnclassifiedTokens, b.TotalTokens},
		ImageCount: d.ImageCount, WebSearchRequests: d.WebSearchRequests,
		UnsupportedDimensions: r.context.Purpose == "image" || hasUnsupportedDimensions(d)}
	r.append(event{Kind: "usage", Context: r.context, ExecutionID: record.RequestID, OccurredAt: timestamp(record.RequestedAt), Usage: f})
}

// Optional zero-valued fields are normal in provider text receipts. Only
// actual additional quantities require an unsupported tariff. Ordinary local
// function-call counters are not hosted service consumption.
func hasUnsupportedDimensions(d usage.Detail) bool {
	positive := func(v *int64) bool { return v != nil && *v > 0 }
	for _, v := range []*int64{d.ImageCount, d.WebSearchRequests, d.AudioInputTokens, d.AudioOutputTokens, d.VideoInputTokens} {
		if positive(v) {
			return true
		}
	}
	if m := d.MediaCounts; m != nil {
		if positive(m.PromptMedia) || positive(m.CompletionMedia) || positive(m.PromptAudio) || (m.AudioSeconds != nil && *m.AudioSeconds > 0) {
			return true
		}
	}
	if t := d.ToolUsageDetails; t != nil {
		for _, v := range []*int64{t.WebSearchCalls, t.WebSearchQueries, t.WebFetchCalls, t.NumSearchResults, t.NumSourcesUsed, t.NumServerSideToolsUsed, t.XSearchCalls, t.XPostsFetched, t.XUsersFetched, t.CodeExecutionCalls, t.FileSearchCalls, t.MCPCalls, t.DocumentSearchCalls, t.ImageGenerationCalls} {
			if positive(v) {
				return true
			}
		}
		for _, v := range t.Extra {
			if v > 0 {
				return true
			}
		}
	}
	return false
}
func (s *Service) deliver(ctx context.Context, j *journal) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.flush(ctx, j); err != nil && ctx.Err() == nil {
				log.Warn("picloud.metering.delivery_pending")
			}
		}
	}
}
func (s *Service) flush(ctx context.Context, j *journal) error {
	batch, err := j.batch()
	if err != nil || len(batch) == 0 {
		return err
	}
	var body bytes.Buffer
	body.WriteString(`{"events":[`)
	for i, item := range batch {
		if i > 0 {
			body.WriteByte(',')
		}
		body.Write(item.raw)
	}
	body.WriteString(`]}`)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.options.Endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.options.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err := s.options.Client.Do(req)
	if err != nil {
		return errors.New("metering receiver unreachable")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4097))
	if err != nil {
		return err
	}
	var ack struct {
		Accepted int `json:"accepted"`
	}
	if res.StatusCode != 200 || len(raw) > 4096 || json.Unmarshal(raw, &ack) != nil || ack.Accepted != len(batch) {
		return errors.New("metering batch not acknowledged")
	}
	return j.acknowledge(batch)
}
