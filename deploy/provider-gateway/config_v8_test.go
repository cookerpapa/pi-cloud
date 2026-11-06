package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/api/handlers/management"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
)

func TestProviderConfigConversionPreservesCredentialsAndProviderBehavior(t *testing.T) {
	raw := []byte("# operator comment\nport: 8317\napi-keys: [client-fixture]\nauth-dir: /data/auth\nproxy-url: http://relay:3129\nrequest-retry: 0\nremote-management:\n  allow-remote: true\n  secret-key: management-fixture\nopenai-compatibility:\n  - name: native\n    base-url: https://example.invalid/v1\n    wire-api: responses\n    api-key-entries:\n      - api-key: provider-fixture\n        proxy-url: direct\n    models:\n      - name: model\n        alias: alias\n")
	before, err := config.ParseConfigBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	converted, err := convertProviderConfig(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	after, err := config.ParseConfigBytes(converted)
	if err != nil {
		t.Fatal(err)
	}
	if after.Port != before.Port || after.AuthDir != before.AuthDir || after.ProxyURL != before.ProxyURL || after.RequestRetry != 0 || after.APIKeys[0] != before.APIKeys[0] {
		t.Fatal("effective runtime configuration changed")
	}
	provider := after.OpenAICompatibility[0]
	if provider.WireAPI != "responses" || provider.APIKeyEntries[0].APIKey != "provider-fixture" || provider.APIKeyEntries[0].ProxyURL != "direct" || provider.Models[0].Alias != "alias" {
		t.Fatal("provider credentials or protocol changed")
	}
	if !bytes.Contains(converted, []byte("# operator comment")) || !bytes.Contains(converted, []byte("management-fixture")) {
		t.Fatal("operator-owned source content was not retained")
	}
	again, err := convertProviderConfig(converted, false)
	if err != nil || !bytes.Equal(again, converted) {
		t.Fatal("conversion is not repeatable")
	}
	var checked bytes.Buffer
	if err := runProviderConfig([]string{"-check"}, bytes.NewReader(converted), &checked); err != nil || checked.String() != "PROVIDER_CONFIG_OK\n" {
		t.Fatalf("validation did not produce a bounded receipt: %v", err)
	}
}

func TestProviderConfigReceiptMatchesNativeManagementWriter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	raw := []byte("# retained comment\nport: 8317\napi-keys: [fixture]\nrequest-retry: 0\n")
	body, err := convertProviderConfig(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.ParseConfigBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	h := management.NewHandler(cfg, path, nil)
	router := gin.New()
	router.PUT("/v8/management/config.yaml", h.ConfigV8)
	router.GET("/v8/management/config.yaml", h.ConfigV8)
	request := httptest.NewRequest(http.MethodPut, "/v8/management/config.yaml", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/yaml")
	request.Header.Set("If-Match", fmt.Sprintf("\"%x\"", sha256.Sum256(raw)))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("native adoption failed: %d", response.Code)
	}
	saved, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(saved, body) {
		t.Fatalf("native writer changed the prepared fixture: got %q want %q", saved, body)
	}
	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v8/management/config.yaml", nil))
	if response.Header().Get("ETag") != fmt.Sprintf("\"%x\"", sha256.Sum256(body)) {
		t.Fatal("native receipt does not identify the adopted document")
	}
}

func TestProviderConfigConversionRejectsInvalidWithoutOutput(t *testing.T) {
	for _, raw := range []string{"", "private: [", strings.Repeat("x", maximumConfigBytes+1), "config-version: 8\nserver:\n  port: wrong\n"} {
		var output bytes.Buffer
		if runProviderConfig(nil, strings.NewReader(raw), &output) == nil || output.Len() != 0 {
			t.Fatal("invalid input produced converted credentials")
		}
	}
}
