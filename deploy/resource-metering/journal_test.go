// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package resourceusage

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"
)

func fixture(t *testing.T) (*Journal, *bolt.DB, Sample) {
	t.Helper()
	db, err := bolt.Open(filepath.Join(t.TempDir(), "meter.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	journal, err := New(db, "node-owned", "boot-a", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return journal, db, Sample{Resource: Identity{Kind: "compute", ResourceID: uuid.NewString(), TenantID: uuid.NewString(), WorkspaceID: uuid.NewString()}, Quantity: Quantity{Kind: "compute", CPUMillis: 2000, MemoryBytes: 2 << 30}, Incarnation: "vm-1", State: "running", At: 1_800_000_000_000}
}
func events(t *testing.T, j *Journal) []Event {
	t.Helper()
	rows, err := j.Batch(128)
	if err != nil {
		t.Fatal(err)
	}
	result := []Event{}
	for _, row := range rows {
		var event Event
		if err = json.Unmarshal(row.Body, &event); err != nil {
			t.Fatal(err)
		}
		result = append(result, event)
	}
	return result
}
func capture(t *testing.T, j *Journal, s Sample) {
	t.Helper()
	if s.Clock.IsZero() {
		s.Clock = time.UnixMilli(s.At)
	}
	if err := j.Capture(s); err != nil {
		t.Fatal(err)
	}
}

func TestPauseResumeAndRestartDoNotChargeUnknownIntervals(t *testing.T) {
	j, db, s := fixture(t)
	capture(t, j, s)
	s.At += 30_000
	capture(t, j, s)
	s.EndedAt = s.At + 5_000
	s.At += 10_000
	s.State = "paused"
	capture(t, j, s)
	s.At += 30_000
	capture(t, j, s)
	s.Incarnation = "vm-2"
	s.State = "running"
	s.StartedAt = s.At + 5_000
	s.At += 10_000
	capture(t, j, s)
	rows := events(t, j)
	if len(rows) != 4 {
		t.Fatalf("unexpected paid intervals: %+v", rows)
	}
	durations := []time.Duration{0, 30 * time.Second, 5 * time.Second, 5 * time.Second}
	for i, row := range rows {
		a, _ := time.Parse(time.RFC3339Nano, row.From)
		b, _ := time.Parse(time.RFC3339Nano, row.To)
		if row.Quality != "confirmed" || b.Sub(a) != durations[i] {
			t.Fatalf("wrong interval: %+v", row)
		}
	}
	restored, err := New(db, "node-owned", "boot-b", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	s.At += 30_000
	capture(t, restored, s)
	rows = events(t, restored)
	if rows[4].Quality != "unconfirmed" || rows[4].Reason != "source_restarted" {
		t.Fatalf("restart guessed duration: %+v", rows[4])
	}
	s.At += 30_000
	capture(t, restored, s)
	if got := events(t, restored)[5]; got.Quality != "confirmed" {
		t.Fatalf("fresh observation did not resume accounting: %+v", got)
	}
}

func TestDelayedObservationAndChangedInstancePreserveGaps(t *testing.T) {
	j, _, s := fixture(t)
	capture(t, j, s)
	s.At += 120_000
	capture(t, j, s)
	s.At += 1000
	s.Incarnation = "replaced"
	capture(t, j, s)
	s.At -= 10_000
	capture(t, j, s)
	rows := events(t, j)
	for _, row := range rows[1:] {
		if row.Quality != "unconfirmed" {
			t.Fatalf("guessed gap: %+v", row)
		}
	}
	cursors, err := j.Cursors()
	if err != nil {
		t.Fatal(err)
	}
	if cursors[0].At < s.At {
		t.Fatal("clock floor moved backwards")
	}
	changed := s
	changed.Resource.TenantID = uuid.NewString()
	changed.Clock = time.UnixMilli(changed.At)
	if j.Capture(changed) == nil {
		t.Fatal("changed resource ownership accepted")
	}
}

type failingDatabase struct {
	*bolt.DB
	fail bool
}

func (db *failingDatabase) Update(update func(*bolt.Tx) error) error {
	if db.fail {
		return errors.New("owned capture failure")
	}
	return db.DB.Update(update)
}

func TestForwardClockStepDoesNotInflateConfirmedDuration(t *testing.T) {
	j, _, s := fixture(t)
	s.Clock = time.UnixMilli(s.At)
	capture(t, j, s)
	s.At += 50_000
	s.Clock = s.Clock.Add(30 * time.Second)
	capture(t, j, s)
	s.At += 30_000
	s.Clock = s.Clock.Add(30 * time.Second)
	capture(t, j, s)
	rows := events(t, j)
	if len(rows) != 3 || rows[1].Quality != "unconfirmed" || rows[1].Reason != "clock_changed" {
		t.Fatalf("clock step became confirmed capacity: %+v", rows)
	}
	if rows[2].Quality != "confirmed" {
		t.Fatalf("fresh clock evidence did not restore confirmation: %+v", rows[2])
	}
}

func TestFailedCapturePreservesAnUnconfirmedGapWithinObservationWindow(t *testing.T) {
	j, db, s := fixture(t)
	storage := &failingDatabase{DB: db}
	j.db = storage
	s.Clock = time.UnixMilli(s.At)
	capture(t, j, s)
	s.At += 10_000
	s.Clock = s.Clock.Add(10 * time.Second)
	storage.fail = true
	if err := j.Capture(s); err == nil {
		t.Fatal("capture failure disappeared")
	}
	storage.fail = false
	s.At += 10_000
	s.Clock = s.Clock.Add(10 * time.Second)
	capture(t, j, s)
	rows := events(t, j)
	if len(rows) != 2 || rows[1].Quality != "unconfirmed" || rows[1].Reason != "collection_unavailable" {
		t.Fatalf("failed capture was joined into confirmed usage: %+v", rows)
	}
	if rows[1].From != timestamp(s.At-20_000) || rows[1].To != timestamp(s.At) {
		t.Fatal("coverage gap lost its known bounds")
	}
}

func TestKnownTerminalCoverageAndSourceCheckpointCommitTogether(t *testing.T) {
	j, db, s := fixture(t)
	s.State = "absent"
	s.CoverageStartedAt = s.At - 20_000
	s.EndedAt = s.At - 5000
	s.Clock = time.UnixMilli(s.At)
	checkpoint := []byte("owned-closed-source")
	err := j.CaptureAndUpdate(s, func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucket(checkpoint); err != nil {
			return err
		}
		return errors.New("owned source checkpoint failure")
	})
	if err == nil || len(events(t, j)) != 0 {
		t.Fatal("receipt survived a failed source checkpoint")
	}
	if err = db.View(func(tx *bolt.Tx) error {
		if tx.Bucket(checkpoint) != nil {
			t.Fatal("source checkpoint survived failed receipt transaction")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = j.CaptureAndUpdate(s, func(tx *bolt.Tx) error {
		_, err := tx.CreateBucket(checkpoint)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	rows := events(t, j)
	if len(rows) != 1 || rows[0].State != "absent" || rows[0].Quality != "unconfirmed" || rows[0].From != timestamp(s.CoverageStartedAt) || rows[0].To != timestamp(s.EndedAt) {
		t.Fatalf("known lifetime disappeared or became a retrospective charge: %+v", rows)
	}
}

func TestFailedFirstCaptureSurvivesAnUnavailableObservation(t *testing.T) {
	j, db, s := fixture(t)
	storage := &failingDatabase{DB: db, fail: true}
	j.db = storage
	s.Clock = time.UnixMilli(s.At)
	start := s.At
	if err := j.Capture(s); err == nil {
		t.Fatal("first capture unexpectedly succeeded")
	}
	storage.fail = false
	s.At += 10_000
	s.Clock = s.Clock.Add(10 * time.Second)
	s.State = "unknown"
	capture(t, j, s)
	s.At += 10_000
	s.Clock = s.Clock.Add(10 * time.Second)
	s.State = "absent"
	capture(t, j, s)
	rows := events(t, j)
	if len(rows) != 2 || rows[0].Quality != "unconfirmed" || rows[0].From != timestamp(start) || rows[0].State != "unknown" || rows[1].State != "absent" || rows[1].Quality != "unconfirmed" {
		t.Fatalf("first-capture failure was forgotten: %+v", rows)
	}
}

func TestDeliveryKeepsLostAcknowledgementsAndNeverFollowsRedirects(t *testing.T) {
	j, _, s := fixture(t)
	capture(t, j, s)
	s.At += 30_000
	capture(t, j, s)
	original, _ := j.Batch(128)
	accepted := false
	attempts := 0
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if r.Header.Get("Authorization") != "Bearer owned-key" {
			t.Error("missing source credential")
		}
		if !accepted {
			w.WriteHeader(503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]int{"accepted": 2})
	}))
	defer receiver.Close()
	if j.Deliver(context.Background(), receiver.URL, "owned-key") == nil {
		t.Fatal("outage acknowledged")
	}
	pending, _ := j.Batch(128)
	if string(pending[0].Body) != string(original[0].Body) {
		t.Fatal("retry receipt changed")
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, receiver.URL, 307) }))
	defer redirect.Close()
	if j.Deliver(context.Background(), redirect.URL, "owned-key") == nil || attempts != 1 {
		t.Fatal("receipt credential followed a redirect")
	}
	accepted = true
	if err := j.Deliver(context.Background(), receiver.URL, "owned-key"); err != nil {
		t.Fatal(err)
	}
	pending, _ = j.Batch(128)
	if len(pending) != 0 {
		t.Fatal("acknowledged receipts not collected")
	}
	// ACK loss can repeat local collection too; it must not underflow the count.
	if err := j.Acknowledge(original); err != nil {
		t.Fatal(err)
	}
}

func TestUnknownClosureDoesNotInventAStopTime(t *testing.T) {
	j, _, s := fixture(t)
	capture(t, j, s)
	s.At += 30_000
	capture(t, j, s)
	s.At += 15_000
	s.State = "absent"
	capture(t, j, s)
	rows := events(t, j)
	if rows[2].Quality != "unconfirmed" {
		t.Fatal("absence invented exact usage")
	}
	batch, _ := j.Batch(128)
	if err := j.Acknowledge(batch); err != nil {
		t.Fatal(err)
	}
	cursors, _ := j.Cursors()
	if len(cursors) != 0 {
		t.Fatal("closed accounting cursor retained after delivery")
	}
	// A remaining inactive native catalog entry cannot create endless zero rows.
	capture(t, j, s)
	if len(events(t, j)) != 0 {
		t.Fatal("inactive catalog recreated billing")
	}
}

func TestDelayedResumeRemainsUnconfirmed(t *testing.T) {
	j, _, s := fixture(t)
	capture(t, j, s)
	s.At += 1000
	s.State = "paused"
	capture(t, j, s)
	s.StartedAt = s.At + 1000
	s.Incarnation = "resumed"
	s.State = "running"
	s.At = s.StartedAt + 120000
	capture(t, j, s)
	rows := events(t, j)
	last := rows[len(rows)-1]
	if last.Quality != "unconfirmed" || last.Reason != "observation_unavailable" {
		t.Fatalf("long resume gap became confirmed: %+v", last)
	}
	s.At += 30000
	capture(t, j, s)
	rows = events(t, j)
	if rows[len(rows)-1].Quality != "confirmed" {
		t.Fatal("fresh observation did not restore continuity")
	}
}
