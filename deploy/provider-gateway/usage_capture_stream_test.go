// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package auth

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/usage"
)

type captureStreamFixture struct {
	ProviderExecutor
	chunks <-chan cliproxyexecutor.StreamChunk
}

func (f *captureStreamFixture) ExecuteStream(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return &cliproxyexecutor.StreamResult{Chunks: f.chunks}, nil
}

type producerCaptureFixture struct {
	active   atomic.Int64
	records  atomic.Int64
	released chan int64
}

func (*producerCaptureFixture) AttemptStarted(string, time.Time) {}
func (f *producerCaptureFixture) Record(usage.Record)            { f.records.Add(1) }
func (f *producerCaptureFixture) RetainProducer() func() {
	f.active.Add(1)
	return func() { f.released <- f.active.Add(-1) }
}

func waitCaptureRelease(t *testing.T, f *producerCaptureFixture, remaining int64) {
	t.Helper()
	select {
	case got := <-f.released:
		if got != remaining {
			t.Fatalf("remaining producers: got %d want %d", got, remaining)
		}
	case <-time.After(time.Second):
		t.Fatal("source producer was not released after its actual EOF")
	}
}

func TestPiCloudCaptureStreamCancellationDrainsUntilProducerEOF(t *testing.T) {
	observer := &producerCaptureFixture{released: make(chan int64, 8)}
	ctx, cancel := context.WithCancel(usage.WithCapture(context.Background(), observer))
	defer cancel()
	chunks := make(chan cliproxyexecutor.StreamChunk)
	result, err := piCloudCaptureStream(ctx, &captureStreamFixture{chunks: chunks}, nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if err != nil || observer.active.Load() != 1 {
		t.Fatal("producer was not retained before execution", err)
	}
	cancel() // The HTTP forwarding layer has already returned.
	if observer.active.Load() != 1 {
		t.Fatal("cancellation invented producer completion")
	}
	producerDone := make(chan struct{})
	go func() {
		defer close(producerDone)
		chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("discarded after cancellation")}
		observer.Record(usage.Record{})
		chunks <- cliproxyexecutor.StreamChunk{Payload: []byte("last payload")}
		observer.Record(usage.Record{})
		close(chunks)
	}()
	waitCaptureRelease(t, observer, 0)
	<-producerDone
	if observer.records.Load() != 2 {
		t.Fatal("late source callbacks were dropped")
	}
	if _, ok := <-result.Chunks; ok {
		t.Fatal("cancelled output was forwarded")
	}
}

func TestPiCloudCaptureStreamPostEOFPubRetainsIndependentLifetime(t *testing.T) {
	observer := &producerCaptureFixture{released: make(chan int64, 8)}
	ctx, finishDelivery := usage.WithStreamDelivery(usage.WithCapture(context.Background(), observer))
	stopSupport := usage.SupportStreamDelivery(ctx)
	// Matches the pinned Antigravity publisher: support can stop early, while
	// accounting stays retained until its outer deferred publication finishes.
	releasePublisher := usage.RetainProducer(ctx)
	chunks := make(chan cliproxyexecutor.StreamChunk)
	result, err := piCloudCaptureStream(ctx, &captureStreamFixture{chunks: chunks}, nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	stopSupport()
	close(chunks)
	if _, ok := <-result.Chunks; ok {
		t.Fatal("unexpected payload")
	}
	waitCaptureRelease(t, observer, 1)
	finishDelivery(nil)
	observer.Record(usage.Record{Model: "primary"})
	observer.Record(usage.Record{Model: "additional"})
	if observer.active.Load() != 1 {
		t.Fatal("EOF was promoted to publication completion")
	}
	releasePublisher()
	releasePublisher()
	waitCaptureRelease(t, observer, 0)
	select {
	case <-observer.released:
		t.Fatal("reference release was not idempotent")
	default:
	}
}

func TestPiCloudCaptureStreamKeepsBlockedProducerActive(t *testing.T) {
	observer := &producerCaptureFixture{released: make(chan int64, 8)}
	ctx, cancel := context.WithCancel(usage.WithCapture(context.Background(), observer))
	chunks := make(chan cliproxyexecutor.StreamChunk)
	_, err := piCloudCaptureStream(ctx, &captureStreamFixture{chunks: chunks}, nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if observer.active.Load() != 1 {
		t.Fatal("an unsettled producer reported inactive")
	}
	select {
	case <-observer.released:
		t.Fatal("context cancellation released an open producer")
	default:
	}
	close(chunks)
	waitCaptureRelease(t, observer, 0)
}

func TestPiCloudCaptureStreamPreservesOrderedOutput(t *testing.T) {
	observer := &producerCaptureFixture{released: make(chan int64, 8)}
	ctx := usage.WithCapture(context.Background(), observer)
	chunks := make(chan cliproxyexecutor.StreamChunk)
	result, err := piCloudCaptureStream(ctx, &captureStreamFixture{chunks: chunks}, nil, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		defer close(chunks)
		for _, value := range []string{"first", "second", "last"} {
			chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(value)}
		}
	}()
	var values []string
	for chunk := range result.Chunks {
		values = append(values, string(chunk.Payload))
	}
	if len(values) != 3 || values[0] != "first" || values[1] != "second" || values[2] != "last" {
		t.Fatalf("stream ordering changed: %v", values)
	}
	waitCaptureRelease(t, observer, 0)
}
