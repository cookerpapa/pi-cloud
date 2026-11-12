// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

func Handler(manager *Manager, token string) http.Handler {
	digest := sha256.Sum256([]byte("Bearer " + token))
	mux := http.NewServeMux()
	reply := func(w http.ResponseWriter, status int, value any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { reply(w, 200, map[string]bool{"alive": true}) })
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if _, err := manager.Pool(); err != nil {
			reply(w, 503, map[string]string{"error": "workspace_quota_unavailable"})
			return
		}
		reply(w, 200, map[string]bool{"ready": true})
	})
	authorize := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			candidate := sha256.Sum256([]byte(r.Header.Get("Authorization")))
			if token == "" || subtle.ConstantTimeCompare(digest[:], candidate[:]) != 1 {
				reply(w, 401, map[string]string{"error": "authentication_required"})
				return
			}
			next(w, r)
		}
	}
	decode := func(w http.ResponseWriter, r *http.Request, value any) bool {
		r.Body = http.MaxBytesReader(w, r.Body, 32*1024)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(value); err != nil {
			reply(w, 400, map[string]string{"error": "invalid_quota_request"})
			return false
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			reply(w, 400, map[string]string{"error": "invalid_quota_request"})
			return false
		}
		return true
	}
	failure := func(w http.ResponseWriter, err error) {
		status, code := 503, "workspace_quota_unavailable"
		switch {
		case errors.Is(err, ErrMissing):
			status, code = 404, "workspace_volume_unavailable"
		case errors.Is(err, ErrConflict):
			status, code = 409, "workspace_quota_conflict"
		case errors.Is(err, ErrClosing):
			status, code = 409, "workspace_volume_closing"
		}
		reply(w, status, map[string]string{"error": code})
	}
	mux.HandleFunc("GET /v1/pool", authorize(func(w http.ResponseWriter, r *http.Request) {
		value, err := manager.Pool()
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, value)
	}))
	mux.HandleFunc("GET /v1/delivery", authorize(func(w http.ResponseWriter, r *http.Request) {
		count, err := manager.PendingCount()
		if err != nil {
			failure(w, err)
			return
		}
		closures, err := manager.PendingClosures()
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, map[string]uint64{"pending": count, "pendingClosures": closures})
	}))
	mux.HandleFunc("POST /v1/storage/inspect", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request StorageRequest
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		value, err := manager.InspectStorage(ctx, request)
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, value)
	}))
	mux.HandleFunc("POST /v1/storage/prepare", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request StoragePrepareRequest
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		value, err := manager.PrepareStorage(ctx, request)
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, value)
	}))
	mux.HandleFunc("POST /v1/storage/destroy", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request StorageRequest
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		if err := manager.DestroyStorage(ctx, request); err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, map[string]bool{"deleted": true})
	}))
	mux.HandleFunc("POST /v1/quota/ensure", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request EnsureRequest
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		value, err := manager.Ensure(ctx, request)
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, value)
	}))
	mux.HandleFunc("POST /v1/quota/read", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request Identity
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		value, err := manager.Read(ctx, request)
		if err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, value)
	}))
	mux.HandleFunc("POST /v1/quota/release", authorize(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			TenantID    string `json:"tenantId"`
			WorkspaceID string `json:"workspaceId"`
			VolumeID    string `json:"volumeId"`
		}
		if !decode(w, r, &request) {
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		if err := manager.ReleaseVolume(ctx, request.TenantID, request.WorkspaceID, request.VolumeID); err != nil {
			failure(w, err)
			return
		}
		reply(w, 200, map[string]bool{"released": true})
	}))
	return mux
}
