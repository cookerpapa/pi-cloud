package auth

import (
	"context"
	"net/http"
	"sync"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

// piCloudImageAttemptGuard is scoped to one non-streaming Images request.
// Account selection may fail before an executor is admitted; after admission,
// uncertainty must return to the caller instead of trying another account/model.
// It retains no cross-request state and does not change chat request policy.
func piCloudImageAttemptGuard(opts executor.Options) executor.Options {
	if opts.SourceFormat.String() != "openai-image" {
		return opts
	}
	prior := opts.RequestAfterAuthInterceptor
	var mu sync.Mutex
	admitted := false
	opts.RequestAfterAuthInterceptor = func(ctx context.Context, request executor.RequestAfterAuthInterceptRequest) executor.RequestAfterAuthInterceptResponse {
		mu.Lock()
		defer mu.Unlock()
		if admitted {
			return executor.RequestAfterAuthInterceptResponse{
				Terminate:       true,
				StatusCode:      http.StatusBadGateway,
				ResponseHeaders: http.Header{"Content-Type": []string{"application/json"}},
				ResponseBody:    []byte(`{"error":{"type":"image_generation_unknown","code":"image_generation_unknown","message":"The image request may already have run; automatic account/model replay was suppressed."}}`),
			}
		}
		result := executor.RequestAfterAuthInterceptResponse{}
		if prior != nil {
			result = prior(ctx, request)
		}
		if !result.Terminate {
			admitted = true
		}
		return result
	}
	return opts
}
