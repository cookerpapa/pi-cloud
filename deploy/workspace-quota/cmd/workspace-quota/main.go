// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	quota "github.com/cookerpapa/pi-cloud/workspace-quota"
)

func required(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("Missing %s", name)
	}
	return value
}
func secret(name string) string {
	body, err := os.ReadFile(required(name))
	if err != nil {
		log.Fatal("Quota credential unavailable")
	}
	value := strings.TrimSpace(string(body))
	if value == "" {
		log.Fatal("Quota credential empty")
	}
	return value
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	root := required("PI_CLOUD_WORKSPACE_POSIX_ROOT")
	token := secret("PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE")
	meteringToken := secret("PI_CLOUD_METERING_TOKEN_FILE")
	meteringURL := required("PI_CLOUD_RESOURCE_METERING_URL")
	manager, err := quota.NewManager(root, required("PI_CLOUD_RESOURCE_METERING_SOURCE_ID"), quota.XFSKernel{})
	if err != nil {
		log.Fatal("Workspace quota startup failed; verify XFS enforcement and source metadata")
	}
	defer manager.Close()
	listen := os.Getenv("PI_CLOUD_WORKSPACE_QUOTA_LISTEN")
	if listen == "" {
		listen = ":4510"
	}
	server := &http.Server{Addr: listen, Handler: quota.Handler(manager, token), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 35 * time.Second, WriteTimeout: 40 * time.Second, IdleTimeout: 60 * time.Second}
	shutdownDone := make(chan struct{})
	collectDone := make(chan struct{})
	deliverDone := make(chan struct{})
	go func() {
		defer close(collectDone)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			if err := manager.Sample(ctx); err != nil && ctx.Err() == nil {
				log.Print("Workspace capacity capture deferred")
			}
			if err := manager.Collect(ctx); err != nil && ctx.Err() == nil {
				log.Print("Workspace quota receipt collection deferred")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	go func() {
		defer close(deliverDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		var warned time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if err := manager.Deliver(ctx, meteringURL, meteringToken); err != nil && ctx.Err() == nil && time.Since(warned) > 30*time.Second {
				log.Print("Workspace capacity receipt delivery pending")
				warned = time.Now()
			}
		}
	}()
	go func() { defer close(shutdownDone); <-ctx.Done(); _ = server.Shutdown(context.Background()) }()

	log.Print("Workspace quota service ready")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print("Workspace quota listener stopped unexpectedly")
		stop()
	}
	<-shutdownDone
	<-collectDone
	<-deliverDone
}
