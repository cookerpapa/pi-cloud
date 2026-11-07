// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package auth

import (
	"context"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

// piCloudCaptureStream observes the existing executor lifetime. It keeps normal
// backpressure, and follows the SDK's existing discard-on-cancel behavior until
// the original producer closes. It never restarts, retries or cancels execution.
func piCloudCaptureStream(ctx context.Context, executor ProviderExecutor, auth *Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	if _, ok := usage.CaptureFromContext(ctx).(usage.ProducerCapture); !ok {
		return executor.ExecuteStream(ctx, auth, req, opts)
	}
	release := usage.RetainProducer(ctx)
	handedOff := false
	defer func() {
		if !handedOff {
			release()
		}
	}()
	result, err := executor.ExecuteStream(ctx, auth, req, opts)
	if result == nil || result.Chunks == nil {
		return result, err
	}
	original := result.Chunks
	copy := *result
	out := make(chan cliproxyexecutor.StreamChunk)
	copy.Chunks = out
	var cancelled <-chan struct{}
	if ctx != nil {
		cancelled = ctx.Done()
	}
	handedOff = true
	go func() {
		defer release()
		defer close(out)
		forward := err == nil
		for chunk := range original {
			if !forward {
				continue
			}
			select {
			case out <- chunk:
			case <-cancelled:
				forward = false
			}
		}
	}()
	return &copy, err
}
