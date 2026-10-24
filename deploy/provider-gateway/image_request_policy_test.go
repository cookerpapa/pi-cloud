package auth

import (
	"context"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/translator"
)

func TestPiCloudImageAttemptGuard(t *testing.T) {
	for _, format := range []string{"openai-image", "openai-response"} {
		t.Run(format, func(t *testing.T) {
			calls := 0
			opts := piCloudImageAttemptGuard(executor.Options{
				SourceFormat: translator.FromString(format),
				RequestAfterAuthInterceptor: func(context.Context, executor.RequestAfterAuthInterceptRequest) executor.RequestAfterAuthInterceptResponse {
					calls++
					return executor.RequestAfterAuthInterceptResponse{Body: []byte("prepared")}
				},
			})
			request := executor.RequestAfterAuthInterceptRequest{}
			first := opts.RequestAfterAuthInterceptor(context.Background(), request)
			second := opts.RequestAfterAuthInterceptor(context.Background(), request)
			if first.Terminate || string(first.Body) != "prepared" {
				t.Fatal("first request must retain the existing interceptor")
			}
			if format == "openai-image" {
				if !second.Terminate || second.StatusCode != 502 || calls != 1 {
					t.Fatal("uncertain Images request reached another executor")
				}
			} else if second.Terminate || calls != 2 {
				t.Fatal("ordinary model request policy changed")
			}
		})
	}
}
