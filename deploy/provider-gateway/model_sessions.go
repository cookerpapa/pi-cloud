// PiCloud-owned transport adapter. Installed into the pinned CPA openai package.
// Pi owns effective context; CPA owns credentials and provider execution.
package openai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/klauspost/compress/zstd"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/interfaces"
	coreexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	sdktranslator "github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
	log "github.com/sirupsen/logrus"
	"github.com/tidwall/gjson"
)

const piCloudMiB = 1024 * 1024

type piCloudSessionCache struct {
	once sync.Once
	pool *piCloudModelSessions
}

type piCloudModelSession struct {
	id, key, auth, responseID string
	parameters                [32]byte
	input                     [][32]byte
	busy                      bool
	created, used             time.Time
	httpUntil                 time.Time
	timer                     *time.Timer
}

type piCloudModelSessions struct {
	mu                                sync.Mutex
	entries                           map[string]*piCloudModelSession
	closeSession                      func(string)
	idle                              time.Duration
	maxEntries                        int
	maxRequest, maxInFlight, inFlight int64
}

func piCloudLimit(name string, fallback, minimum, maximum int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < minimum || n > maximum {
		panic("invalid " + name)
	}
	return n
}

func newPiCloudModelSessions(closeSession func(string)) *piCloudModelSessions {
	return &piCloudModelSessions{
		entries: make(map[string]*piCloudModelSession), closeSession: closeSession,
		idle:        time.Duration(piCloudLimit("PI_CLOUD_MODEL_SESSION_IDLE_SECONDS", 900, 1, 3300)) * time.Second,
		maxEntries:  int(piCloudLimit("PI_CLOUD_MODEL_SESSION_CACHE_ENTRIES", 256, 1, 10000)),
		maxRequest:  piCloudLimit("PI_CLOUD_MODEL_REQUEST_MAX_BYTES", 256*piCloudMiB, piCloudMiB, 1024*piCloudMiB),
		maxInFlight: piCloudLimit("PI_CLOUD_MODEL_UPLOAD_MAX_BYTES", 512*piCloudMiB, piCloudMiB, 4*1024*piCloudMiB),
	}
}

func (p *piCloudModelSessions) acquire(key string) (*piCloudModelSession, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	if s := p.entries[key]; s != nil {
		if s.busy {
			return nil, errors.New("model_session_busy")
		}
		if now.Sub(s.used) < p.idle && now.Sub(s.created) < 55*time.Minute && (s.httpUntil.IsZero() || now.Before(s.httpUntil)) {
			s.busy = true
			if s.timer != nil {
				s.timer.Stop()
			}
			return s, nil
		}
		p.removeLocked(s)
	}
	if len(p.entries) >= p.maxEntries {
		var oldest *piCloudModelSession
		for _, s := range p.entries {
			if !s.busy && (oldest == nil || s.used.Before(oldest.used)) {
				oldest = s
			}
		}
		if oldest == nil {
			return nil, errors.New("model_session_capacity_exhausted")
		}
		p.removeLocked(oldest)
	}
	s := &piCloudModelSession{id: "picloud-model-" + uuid.NewString(), key: key, busy: true, created: now, used: now}
	p.entries[key] = s
	return s, nil
}

func (p *piCloudModelSessions) removeLocked(s *piCloudModelSession) {
	if p.entries[s.key] != s {
		return
	}
	delete(p.entries, s.key)
	if s.timer != nil {
		s.timer.Stop()
	}
	p.closeSession(s.id)
	s.input = nil
}

func (p *piCloudModelSessions) finish(s *piCloudModelSession, keep bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.entries[s.key] != s {
		return
	}
	if !keep {
		p.removeLocked(s)
		return
	}
	s.busy, s.used = false, time.Now()
	s.timer = time.AfterFunc(p.idle, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if !s.busy && time.Since(s.used) >= p.idle {
			p.removeLocked(s)
		}
	})
}

func (p *piCloudModelSessions) reserve(n int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n > 0 && p.inFlight+n > p.maxInFlight {
		return false
	}
	p.inFlight += n
	return true
}

func piCloudJSON(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value any
	if err := d.Decode(&value); err != nil {
		return nil, err
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}

// Compare provider replay fields conservatively. Completed output has transport
// status/logprobs which Pi does not replay; Tool arguments are parsed/re-encoded.
// All other fields remain significant. Unknown differences cause a cold request.
func piCloudItemDigest(raw []byte) ([32]byte, error) {
	v, err := piCloudJSON(raw)
	if err != nil {
		return [32]byte{}, err
	}
	if item, ok := v.(map[string]any); ok {
		switch item["type"] {
		case "function_call", "custom_tool_call":
			delete(item, "status")
			if args, ok := item["arguments"].(string); ok {
				if parsed, e := piCloudJSON([]byte(args)); e == nil {
					encoded, _ := json.Marshal(parsed)
					item["arguments"] = string(encoded)
				}
			}
		case "message":
			if content, ok := item["content"].([]any); ok {
				for _, part := range content {
					if m, ok := part.(map[string]any); ok {
						delete(m, "logprobs")
					}
				}
			}
		}
	}
	b, err := json.Marshal(v)
	return sha256.Sum256(b), err
}

type piCloudRequest struct {
	fields       map[string]json.RawMessage
	input        []gjson.Result
	parameters   [32]byte
	fingerprints [][32]byte
}

func piCloudParseRequest(raw []byte) (*piCloudRequest, error) {
	if !gjson.ValidBytes(raw) {
		return nil, errors.New("invalid_request")
	}
	root := gjson.ParseBytes(raw)
	if !root.IsObject() || !root.Get("input").IsArray() || root.Get("model").String() == "" || !root.Get("stream").Bool() || root.Get("store").Bool() || root.Get("previous_response_id").Exists() {
		return nil, errors.New("invalid_request")
	}
	r := &piCloudRequest{fields: make(map[string]json.RawMessage), input: root.Get("input").Array()}
	root.ForEach(func(k, v gjson.Result) bool {
		if k.String() != "input" && k.String() != "stream" {
			r.fields[k.String()] = json.RawMessage(v.Raw)
		}
		return true
	})
	parameters, err := json.Marshal(r.fields)
	if err != nil {
		return nil, err
	}
	// Canonicalize nested request properties as well as top-level keys.
	v, err := piCloudJSON(parameters)
	if err != nil {
		return nil, err
	}
	parameters, _ = json.Marshal(v)
	r.parameters = sha256.Sum256(parameters)
	for _, item := range r.input {
		digest, err := piCloudItemDigest([]byte(item.Raw))
		if err != nil {
			return nil, err
		}
		r.fingerprints = append(r.fingerprints, digest)
	}
	return r, nil
}

func (r *piCloudRequest) payload(s *piCloudModelSession) ([]byte, bool, error) {
	start := 0
	matched := s.responseID != "" && s.parameters == r.parameters && len(r.fingerprints) >= len(s.input)
	if matched {
		for i, v := range s.input {
			if r.fingerprints[i] != v {
				matched = false
				break
			}
		}
	}
	if matched {
		start = len(s.input)
	}
	fields := make(map[string]json.RawMessage, len(r.fields)+2)
	for k, v := range r.fields {
		fields[k] = v
	}
	if matched {
		fields["previous_response_id"], _ = json.Marshal(s.responseID)
	}
	input := make([]json.RawMessage, 0, len(r.input)-start)
	for _, item := range r.input[start:] {
		input = append(input, json.RawMessage(item.Raw))
	}
	fields["input"], _ = json.Marshal(input)
	fields["stream"] = json.RawMessage("true")
	b, err := json.Marshal(fields)
	return b, matched, err
}

type piCloudBodyBuffer struct {
	bytes.Buffer
	maximum int64
	reserve func(int64) bool
}

func (b *piCloudBodyBuffer) Write(data []byte) (int, error) {
	if int64(b.Len()+len(data)) > b.maximum {
		return 0, errors.New("request_too_large")
	}
	if b.reserve != nil && !b.reserve(int64(len(data))) {
		return 0, errors.New("model_upload_capacity_exhausted")
	}
	return b.Buffer.Write(data)
}

func piCloudReadBody(c *gin.Context, maximum int64, reservations ...func(int64) bool) ([]byte, string) {
	var reader io.Reader = io.LimitReader(c.Request.Body, maximum+1)
	encoding := strings.ToLower(strings.TrimSpace(c.GetHeader("Content-Encoding")))
	if encoding != "" {
		if encoding != "zstd" {
			return nil, "unsupported_content_encoding"
		}
		decoder, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(uint64(maximum)))
		if err != nil {
			return nil, "invalid_request_encoding"
		}
		defer decoder.Close()
		reader = decoder
	}
	body := &piCloudBodyBuffer{maximum: maximum}
	if len(reservations) > 0 {
		body.reserve = reservations[0]
	}
	_, err := io.CopyBuffer(struct{ io.Writer }{body}, io.LimitReader(reader, maximum+1), make([]byte, 64*1024))
	if err != nil && err.Error() == "model_upload_capacity_exhausted" {
		return nil, "model_upload_capacity_exhausted"
	}
	if (err != nil && err.Error() == "request_too_large") || errors.Is(err, zstd.ErrDecoderSizeExceeded) || errors.Is(err, zstd.ErrWindowSizeExceeded) {
		return nil, "request_too_large"
	}
	if err != nil {
		return nil, "invalid_request_encoding"
	}
	return body.Bytes(), ""
}

func piCloudModelError(c *gin.Context, status int, code string, messages ...string) {
	message := "Model provider connection error"
	switch code {
	case "request_too_large":
		message = "Model request is too large; use /compact before retrying"
	case "invalid_request_encoding":
		message = "Model request compression is invalid"
	case "invalid_request":
		message = "Model request is invalid"
	case "model_session_busy", "model_session_capacity_exhausted", "model_upload_capacity_exhausted":
		message = "Model transport capacity is temporarily unavailable"
	}
	if len(messages) > 0 && messages[0] != "" {
		message = messages[0]
	}
	err := gin.H{"code": code, "message": message, "type": "server_error"}
	if c.Writer.Written() {
		b, _ := json.Marshal(gin.H{"type": "error", "error": err, "code": code, "message": message})
		fmt.Fprintf(c.Writer, "data: %s\n\n", b)
		c.Writer.Flush()
		return
	}
	c.JSON(status, gin.H{"error": err})
}

// PiCloudResponses is a full-input HTTP/SSE port. Only CPA's native WebSocket
// executor keeps upstream state. No Run/lease/Kafka authority enters this cache.
func (h *OpenAIResponsesAPIHandler) PiCloudResponses(c *gin.Context) {
	h.piCloud.once.Do(func() { h.piCloud.pool = newPiCloudModelSessions(h.AuthManager.CloseExecutionSession) })
	p := h.piCloud.pool
	key := c.GetHeader("X-PiCloud-Model-Session")
	if len(key) != 64 {
		piCloudModelError(c, 400, "invalid_request")
		return
	}
	if _, err := hex.DecodeString(key); err != nil {
		piCloudModelError(c, 400, "invalid_request")
		return
	}
	// Separate cache ownership by the already authenticated client key too.
	client := sha256.Sum256([]byte(c.GetHeader("Authorization") + ":" + key))
	key = hex.EncodeToString(client[:])
	// Account actual decoded chunks before retaining them; small concurrent
	// requests do not reserve a maximum-sized upload each.
	var reserved int64
	defer func() { p.reserve(-reserved) }()
	raw, code := piCloudReadBody(c, p.maxRequest, func(n int64) bool {
		if !p.reserve(n) {
			return false
		}
		reserved += n
		return true
	})
	if code != "" {
		status := 400
		if code == "request_too_large" {
			status = 413
		}
		if code == "model_upload_capacity_exhausted" {
			status = 429
		}
		piCloudModelError(c, status, code)
		return
	}
	r, err := piCloudParseRequest(raw)
	if err != nil {
		piCloudModelError(c, 400, "invalid_request")
		return
	}
	// CPA receives decoded JSON below. Ingress compression/length must not
	// describe the executor's rebuilt upstream request.
	c.Request.Header.Del("Content-Encoding")
	c.Request.Header.Del("Content-Length")
	s, err := p.acquire(key)
	if err != nil {
		piCloudModelError(c, 429, err.Error())
		return
	}
	keep := false
	defer func() { p.finish(s, keep) }()
	payload, incremental, err := r.payload(s)
	if err != nil {
		piCloudModelError(c, 400, "invalid_request")
		return
	}
	cacheReason := "cold"
	if incremental {
		cacheReason = "prefix_match"
	} else if s.responseID != "" {
		cacheReason = "prefix_changed"
		if s.parameters != r.parameters {
			cacheReason = "request_properties_changed"
		}
	}
	if !incremental && (s.responseID != "" || (s.parameters != [32]byte{} && s.parameters != r.parameters)) {
		p.closeSession(s.id)
		s.id, s.auth, s.responseID, s.input = "picloud-model-"+uuid.NewString(), "", "", nil
		s.created = time.Now()
		s.httpUntil = time.Time{}
	}
	started := time.Now()
	upstreamBytes := len(payload)
	c.Header("X-PiCloud-Model-Full-Bytes", strconv.Itoa(len(raw)))
	defer func() {
		log.WithFields(log.Fields{"session": key, "runId": c.GetHeader("x-picloud-run-id"), "cacheReason": cacheReason, "incremental": incremental, "requestBytes": len(raw), "upstreamBytes": upstreamBytes, "completed": keep, "elapsedMs": time.Since(started).Milliseconds(), "stepSequence": c.GetHeader("x-pi-cloud-step-sequence")}).Info("picloud.model.transport")
	}()
	httpMode := time.Now().Before(s.httpUntil)
	for attempt := 0; attempt < 3; attempt++ {
		c.Header("X-PiCloud-Model-Cache", cacheReason)
		c.Header("X-PiCloud-Model-Upstream-Bytes", strconv.Itoa(upstreamBytes))
		completion, failure := h.piCloudAttempt(c, p, s, payload, incremental, httpMode)
		if failure == nil {
			if httpMode || time.Now().Before(s.httpUntil) {
				s.parameters = r.parameters
				keep = true
				return
			}
			response := gjson.GetBytes(completion, "response")
			baseline := append([][32]byte(nil), r.fingerprints...)
			for _, item := range response.Get("output").Array() {
				digest, err := piCloudItemDigest([]byte(item.Raw))
				if err != nil {
					return
				}
				baseline = append(baseline, digest)
			}
			if len(baseline)*32 > 2*piCloudMiB {
				return
			}
			s.parameters, s.input, s.responseID = r.parameters, baseline, response.Get("id").String()
			keep = true
			return
		}
		if c.Request.Context().Err() != nil {
			return
		}
		if !c.Writer.Written() && incremental && failure.missing {
			cacheReason = "missing_response"
			p.closeSession(s.id)
			s.id = "picloud-model-" + uuid.NewString()
			s.responseID = ""
			s.input = nil
			payload, incremental, _ = r.payload(s)
			upstreamBytes += len(payload)
			continue
		}
		// Match Pi's existing pre-output WebSocket -> HTTP fallback, once. Once
		// a provider event was delivered, native Pi owns any semantic retry.
		if !c.Writer.Written() && !httpMode && failure.transport {
			cacheReason = "websocket_failed"
			p.closeSession(s.id)
			s.responseID = ""
			s.input = nil
			s.auth = ""
			s.httpUntil = time.Now().Add(5 * time.Minute)
			httpMode = true
			payload, incremental, _ = r.payload(s)
			upstreamBytes += len(payload)
			continue
		}
		if failure.code == "provider_response_failed" && c.Writer.Written() {
			return
		}
		piCloudModelError(c, failure.status, failure.code, failure.message)
		return
	}
	piCloudModelError(c, 502, "provider_gateway_unavailable")
}

type piCloudAttemptError struct {
	status             int
	code               string
	message            string
	missing, transport bool
}

func piCloudFailure(err error) *piCloudAttemptError {
	f := &piCloudAttemptError{status: 502, code: "provider_gateway_unavailable"}
	var status coreexecutor.StatusError
	if errors.As(err, &status) {
		f.status = status.StatusCode()
	}
	code := gjson.Get(err.Error(), "error.code").String()
	if code == "" {
		code = gjson.Get(err.Error(), "response.error.code").String()
	}
	f.missing = coreexecutor.IsUpstreamWebsocketReplayRequired(err) || code == "previous_response_not_found"
	var network net.Error
	var closed *websocket.CloseError
	f.transport = errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &network) || errors.As(err, &closed)
	if f.status == 426 && !f.missing {
		f.transport = true
	}
	if f.status == 429 {
		f.code = "provider_rate_limited"
	}
	if f.status == 401 || f.status == 403 {
		f.code = "provider_authentication_failed"
	}
	if f.status == 400 {
		f.code = "provider_request_rejected"
	}
	if f.status == 413 {
		f.code = "request_too_large"
		f.message = "Model request is too large; use /compact before retrying"
		return f
	}
	// Preserve CPA's existing redacted provider error contract. Native Pi needs
	// context-overflow/quota distinctions to compact or avoid futile retries.
	if code != "" || (f.status >= 400 && f.status < 500) {
		safe := responsesStreamErrorText(&interfaces.ErrorMessage{StatusCode: f.status, Error: err}, f.status)
		message := gjson.Get(safe, "error.message").String()
		if message == "" {
			message = gjson.Get(safe, "message").String()
		}
		if message == "" && !json.Valid([]byte(safe)) {
			message = safe
		}
		if message != "" {
			f.message = message
			if code != "" {
				f.message = code + ": " + message
			}
		}
	}
	return f
}

func (h *OpenAIResponsesAPIHandler) piCloudAttempt(c *gin.Context, p *piCloudModelSessions, s *piCloudModelSession, payload []byte, incremental, httpMode bool) ([]byte, *piCloudAttemptError) {
	transport := "websocket"
	if httpMode {
		transport = "http"
	}
	c.Header("X-PiCloud-Model-Transport", transport)
	c.Header("X-PiCloud-Model-Incremental", strconv.FormatBool(incremental))
	ctx, cancel := h.GetContextWithCancel(h, c, c.Request.Context())
	if !httpMode {
		ctx = coreexecutor.WithDownstreamWebsocket(ctx)
	}
	if incremental {
		ctx = coreexecutor.WithRequiredUpstreamWebsocket(ctx)
	}
	model := gjson.GetBytes(payload, "model").String()
	metadata := map[string]any{coreexecutor.ExecutionSessionMetadataKey: s.id, coreexecutor.RequestedModelMetadataKey: model, coreexecutor.SelectedAuthCallbackMetadataKey: func(id string) { s.auth = id }}
	if s.auth != "" {
		metadata[coreexecutor.PinnedAuthMetadataKey] = s.auth
	}
	cancelled := make(chan struct{})
	upstreamID := s.id
	stopCancel := context.AfterFunc(ctx, func() { p.closeSession(upstreamID); close(cancelled) })
	var detachOnce sync.Once
	detachCancel := func() {
		detachOnce.Do(func() {
			if !stopCancel() {
				<-cancelled
			}
		})
	}
	defer func() {
		detachCancel()
		cancel()
	}()
	headers := c.Request.Header.Clone()
	for name := range headers {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-picloud-") || strings.HasPrefix(lower, "x-pi-cloud-") {
			headers.Del(name)
		}
	}
	result, err := h.AuthManager.ExecuteStream(ctx, []string{"codex"}, coreexecutor.Request{Model: model, Payload: payload}, coreexecutor.Options{Stream: true, OriginalRequest: payload, SourceFormat: sdktranslator.FromString("openai-response"), ResponseFormat: sdktranslator.FromString("openai-response"), Headers: headers, Metadata: metadata})
	if err != nil {
		return nil, piCloudFailure(err)
	}
	if result == nil || result.Chunks == nil {
		return nil, &piCloudAttemptError{status: 502, code: "provider_response_incomplete"}
	}
	framer := &responsesSSEFramer{}
	total := 0
	for {
		select {
		case <-ctx.Done():
			return nil, piCloudFailure(ctx.Err())
		case chunk, ok := <-result.Chunks:
			if !ok {
				if httpMode {
					framer.Flush(c.Writer)
					c.Writer.Flush()
					if framer.terminalEvent == "response.completed" && framer.terminalError == nil {
						return nil, nil
					}
				}
				return nil, &piCloudAttemptError{status: 502, code: "provider_response_incomplete"}
			}
			if chunk.Err != nil {
				return nil, piCloudFailure(chunk.Err)
			}
			event := chunk.Payload
			total += len(event)
			if total > 64*piCloudMiB {
				return nil, &piCloudAttemptError{status: 502, code: "provider_response_too_large"}
			}
			if !c.Writer.Written() && bytes.HasPrefix(bytes.TrimSpace(event), []byte("data:")) {
				httpMode = true
				s.httpUntil = time.Now().Add(5 * time.Minute)
				c.Header("X-PiCloud-Model-Transport", "http")
				c.Header("X-PiCloud-Model-Incremental", "false")
			}
			if httpMode {
				if !c.Writer.Written() {
					c.Header("Content-Type", "text/event-stream")
					c.Header("Cache-Control", "no-store")
					c.Status(200)
				}
				var framed bytes.Buffer
				framer.WriteChunk(&framed, event)
				completed := framer.terminalEvent == "response.completed" && framer.terminalError == nil
				if completed {
					detachCancel()
					if ctx.Err() != nil {
						return nil, piCloudFailure(ctx.Err())
					}
				}
				if _, err := c.Writer.Write(framed.Bytes()); err != nil {
					return nil, piCloudFailure(err)
				}
				c.Writer.Flush()
				if completed {
					return nil, nil
				}
				continue
			}
			if !json.Valid(event) {
				return nil, &piCloudAttemptError{status: 502, code: "provider_response_invalid"}
			}
			typeName := gjson.GetBytes(event, "type").String()
			if incremental && typeName == "error" && gjson.GetBytes(event, "error.code").String() == "previous_response_not_found" {
				return nil, &piCloudAttemptError{status: 400, code: "previous_response_not_found", missing: true}
			}
			if typeName == "response.completed" {
				r := gjson.GetBytes(event, "response")
				if r.Get("status").String() != "completed" || r.Get("id").String() == "" || !r.Get("output").IsArray() {
					return nil, &piCloudAttemptError{status: 502, code: "provider_response_invalid"}
				}
				// Pi cancels its HTTP reader after this terminal event. Detach the
				// active-request cancellation hook before publishing completion,
				// so that normal reader cleanup cannot close completed idle state.
				detachCancel()
				if ctx.Err() != nil {
					return nil, piCloudFailure(ctx.Err())
				}
			}
			if !c.Writer.Written() {
				c.Header("Content-Type", "text/event-stream")
				c.Header("Cache-Control", "no-store")
				c.Status(200)
			}
			if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", event); err != nil {
				return nil, piCloudFailure(err)
			}
			c.Writer.Flush()
			if typeName == "response.completed" {
				r := gjson.GetBytes(event, "response")
				if r.Get("status").String() != "completed" || r.Get("id").String() == "" || !r.Get("output").IsArray() {
					return nil, &piCloudAttemptError{status: 502, code: "provider_response_invalid"}
				}
				return event, nil
			}
			if typeName == "response.failed" || typeName == "response.incomplete" || typeName == "error" {
				return nil, &piCloudAttemptError{status: 502, code: "provider_response_failed"}
			}
		}
	}
}
