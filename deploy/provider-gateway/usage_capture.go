package usage

import (
	"context"
	"sync"
	"time"
)

// Capture is an optional synchronous source observer. Implementations must not
// replay model work or retain caller-owned payloads. A failed capture must not
// turn a completed model execution into a retryable executor failure.
type Capture interface {
	AttemptStarted(id string, at time.Time)
	Record(record Record)
}

// ProducerCapture optionally retains accounting admission while an executor
// can still publish usage after its HTTP consumer or output channel has ended.
// The returned release is invoked only after the final synchronous callback.
type ProducerCapture interface {
	RetainProducer() func()
}

func RetainProducer(ctx context.Context) func() {
	observer, ok := CaptureFromContext(ctx).(ProducerCapture)
	if !ok {
		return func() {}
	}
	release := observer.RetainProducer()
	var once sync.Once
	return func() {
		once.Do(func() {
			if release != nil {
				release()
			}
		})
	}
}

type captureKey struct{}

func WithCapture(ctx context.Context, capture Capture) context.Context {
	return context.WithValue(ctx, captureKey{}, capture)
}

func CaptureFromContext(ctx context.Context) Capture {
	if ctx == nil {
		return nil
	}
	capture, _ := ctx.Value(captureKey{}).(Capture)
	return capture
}

// InheritCapture copies the immutable request observer when a handler starts a
// fresh execution context. It never reads a pooled HTTP/Gin context asynchronously.
func InheritCapture(ctx, request context.Context) context.Context {
	if capture := CaptureFromContext(request); capture != nil {
		return WithCapture(ctx, capture)
	}
	return ctx
}
