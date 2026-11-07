// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package resourceusage

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"
)

type Database interface {
	Update(func(*bolt.Tx) error) error
	View(func(*bolt.Tx) error) error
}
type Identity struct {
	Kind        string `json:"kind"`
	ResourceID  string `json:"resourceId"`
	TenantID    string `json:"tenantId"`
	WorkspaceID string `json:"workspaceId"`
}
type Quantity struct {
	Kind          string `json:"kind"`
	CPUMillis     int64  `json:"cpuMillis,omitempty"`
	MemoryBytes   int64  `json:"memoryBytes,omitempty"`
	CapacityBytes int64  `json:"capacityBytes,omitempty"`
}
type Event struct {
	Version      int      `json:"version"`
	EventID      string   `json:"eventId"`
	Resource     Identity `json:"resource"`
	SourceID     string   `json:"sourceId"`
	SourceBootID string   `json:"sourceBootId"`
	Incarnation  string   `json:"incarnation"`
	From         string   `json:"from"`
	To           string   `json:"to"`
	Quality      string   `json:"quality"`
	Reason       string   `json:"reason,omitempty"`
	State        string   `json:"state"`
	Quantity     Quantity `json:"quantity"`
}
type Sample struct {
	Resource    Identity
	Quantity    Quantity
	Incarnation string
	State       string
	At          int64
	// Clock retains Go's process-local monotonic observation clock. At is the
	// corresponding wall timestamp; synthetic fixtures may advance them separately.
	Clock time.Time
	// Native physical timestamps are optional evidence, not inferred deadlines.
	StartedAt       int64
	EndedAt         int64
	UncertainReason string
	// CoverageStartedAt is persisted source evidence for a known resource whose
	// first capture may have failed. It only creates unconfirmed coverage, never
	// a retrospective confirmed charge or an execution/lifecycle decision.
	CoverageStartedAt int64
}
type Cursor struct {
	Resource    Identity `json:"resource"`
	Quantity    Quantity `json:"quantity"`
	Incarnation string   `json:"incarnation"`
	State       string   `json:"state"`
	At          int64    `json:"at"`
	BootID      string   `json:"bootId"`
}
type Journal struct {
	db               Database
	SourceID, BootID string
	BootAt           int64
	captureMu        sync.Mutex
	observations     map[string]observation
}

type observation struct {
	clock    time.Time
	at       int64
	failed   bool
	failedAt int64
}

var root = []byte("pi-cloud.resource-usage.v1")
var cursors = []byte("cursors")
var pending = []byte("pending")
var pendingCount = []byte("pending-count")
var ErrFull = errors.New("resource receipt buffer is full")

const MaxPending = 65536
const MaximumObservedInterval = 90 * time.Second

func New(db Database, sourceID, bootID string, now time.Time) (*Journal, error) {
	if db == nil || sourceID == "" || bootID == "" {
		return nil, errors.New("resource metering configuration missing")
	}
	j := &Journal{db: db, SourceID: sourceID, BootID: bootID, BootAt: now.UnixMilli(), observations: map[string]observation{}}
	err := db.Update(func(tx *bolt.Tx) error {
		if tx.DB().NoSync {
			return errors.New("resource receipts require synchronous metadata")
		}
		b, err := tx.CreateBucketIfNotExists(root)
		if err != nil {
			return err
		}
		if _, err = b.CreateBucketIfNotExists(cursors); err != nil {
			return err
		}
		pb, err := b.CreateBucketIfNotExists(pending)
		if err != nil {
			return err
		}
		if b.Get(pendingCount) == nil {
			if pb.Stats().KeyN != 0 {
				return errors.New("resource counter missing")
			}
			return b.Put(pendingCount, make([]byte, 8))
		}
		return nil
	})
	return j, err
}
func key(r Identity) []byte     { return []byte(r.Kind + ":" + r.ResourceID) }
func timestamp(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }
func (j *Journal) Cursors() ([]Cursor, error) {
	rows := []Cursor{}
	err := j.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(root).Bucket(cursors).ForEach(func(_, v []byte) error {
			var c Cursor
			if err := json.Unmarshal(v, &c); err != nil {
				return err
			}
			rows = append(rows, c)
			return nil
		})
	})
	return rows, err
}
func active(state string) bool { return state == "running" || state == "retained" }
func (j *Journal) Capture(s Sample) error {
	return j.CaptureAndUpdate(s, nil)
}

// CaptureAndUpdate commits bounded source metadata with the receipt and cursor.
// Essential physical cleanup must remain independent of this transaction's success.
func (j *Journal) CaptureAndUpdate(s Sample, update func(*bolt.Tx) error) error {
	if s.Resource.ResourceID == "" || s.Incarnation == "" || s.At <= 0 || s.Clock.IsZero() || s.Resource.Kind != s.Quantity.Kind || s.CoverageStartedAt < 0 {
		return errors.New("invalid resource observation")
	}
	if _, err := uuid.Parse(s.Resource.TenantID); err != nil {
		return err
	}
	if _, err := uuid.Parse(s.Resource.WorkspaceID); err != nil {
		return err
	}
	j.captureMu.Lock()
	defer j.captureMu.Unlock()
	id := string(key(s.Resource))
	previous, known := j.observations[id]
	if known {
		wall := s.At - previous.at
		elapsed := s.Clock.Sub(previous.clock).Milliseconds()
		if wall-elapsed > 1000 || elapsed-wall > 1000 {
			s.UncertainReason = "clock_changed"
		}
		if previous.failed && s.UncertainReason == "" {
			s.UncertainReason = "collection_unavailable"
		}
		if previous.failed && s.CoverageStartedAt == 0 {
			s.CoverageStartedAt = previous.failedAt
		}
	}
	captured := false
	err := j.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(root)
		cb, pb := b.Bucket(cursors), b.Bucket(pending)
		var old Cursor
		raw := cb.Get(key(s.Resource))
		if raw != nil {
			if err := json.Unmarshal(raw, &old); err != nil {
				return err
			}
			if old.Resource != s.Resource {
				return errors.New("resource owner changed")
			}
			if old.State == "absent" && s.State != "absent" {
				return errors.New("closed resource observation is stale")
			}
			if s.State == "unknown" {
				s.Quantity = old.Quantity
			}
		}
		next := Cursor{Resource: s.Resource, Quantity: s.Quantity, Incarnation: s.Incarnation, State: s.State, At: s.At, BootID: j.BootID}
		from, to := s.At, s.At
		quality, reason := "confirmed", ""
		emit := false
		if raw == nil {
			if !active(s.State) && s.CoverageStartedAt == 0 {
				if update != nil {
					return update(tx)
				}
				return nil
			}
			// Start at first capture. No retrospective charge for pre-existing VMs.
			emit = true
			if s.CoverageStartedAt > 0 {
				from = min(s.CoverageStartedAt, s.At)
				if (s.State == "paused" || s.State == "absent") && s.EndedAt > 0 {
					to = max(from, min(s.EndedAt, s.At))
				}
				quality, reason = "unconfirmed", "collection_unavailable"
				if s.UncertainReason != "" {
					reason = s.UncertainReason
				}
			}
		} else {
			from = old.At
			to = max(s.At, old.At)
			next.At = to
			switch {
			case s.At < old.At:
				quality, reason, emit = "unconfirmed", "clock_changed", true
			case s.UncertainReason != "":
				quality, reason, emit = "unconfirmed", s.UncertainReason, true
			case old.BootID != j.BootID:
				quality, reason, emit = "unconfirmed", "source_restarted", to > from
			case s.Incarnation != old.Incarnation:
				// A verified native resume from a known paused state can start
				// at the new physical timestamp. Other replacements leave a gap.
				if old.State == "paused" && active(s.State) && s.StartedAt >= old.At && s.StartedAt <= s.At {
					from = s.StartedAt
					emit = to > from
					if to-from > MaximumObservedInterval.Milliseconds() {
						quality, reason = "unconfirmed", "observation_unavailable"
					}
				} else {
					quality, reason, emit = "unconfirmed", "instance_changed", to > from
				}
			case s.Quantity != old.Quantity:
				quality, reason, emit = "unconfirmed", "observation_unavailable", to > from
			case active(old.State) && active(s.State) && to-from <= MaximumObservedInterval.Milliseconds():
				emit = to > from
			case active(old.State) && (s.State == "paused" || s.State == "absent") && s.EndedAt >= from && s.EndedAt <= to:
				to = s.EndedAt
				emit = to > from
			case old.State == s.State && !active(s.State) && s.State != "unknown":
				// Confirmed paused/absent resources consume no compute time.
			default:
				quality, reason, emit = "unconfirmed", "observation_unavailable", to > from
			}
		}
		if (s.State == "paused" || s.State == "absent") && s.EndedAt >= from && s.EndedAt <= to {
			to = s.EndedAt
		}
		if raw != nil && old.State != s.State && (s.State == "paused" || s.State == "absent") {
			emit = true
		}
		if emit {
			countRaw := b.Get(pendingCount)
			if len(countRaw) != 8 {
				return errors.New("resource counter invalid")
			}
			count := binary.BigEndian.Uint64(countRaw)
			if count >= MaxPending {
				return ErrFull
			}
			event := Event{Version: 1, EventID: uuid.NewString(), Resource: s.Resource, SourceID: j.SourceID, SourceBootID: j.BootID,
				Incarnation: s.Incarnation, From: timestamp(from), To: timestamp(to), Quality: quality, Reason: reason, State: s.State, Quantity: s.Quantity}
			body, err := json.Marshal(event)
			if err != nil {
				return err
			}
			seq, err := pb.NextSequence()
			if err != nil {
				return err
			}
			k := make([]byte, 8)
			binary.BigEndian.PutUint64(k, seq)
			if err = pb.Put(k, body); err != nil {
				return err
			}
			n := make([]byte, 8)
			binary.BigEndian.PutUint64(n, count+1)
			if err = b.Put(pendingCount, n); err != nil {
				return err
			}
		}
		body, err := json.Marshal(next)
		if err != nil {
			return err
		}
		if err := cb.Put(key(s.Resource), body); err != nil {
			return err
		}
		captured = true
		if update != nil {
			return update(tx)
		}
		return nil
	})
	if err != nil {
		if !known {
			previous.clock, previous.at = s.Clock, s.At
		}
		if !previous.failed {
			previous.failedAt = s.At
		}
		previous.failed = true
		j.observations[id] = previous
	} else if !captured || s.State == "absent" {
		// Do not retain ephemeral state for never-observed inactive resources.
		// Known first-capture failures have now become durable unknown cursors.
		delete(j.observations, id)
	} else {
		j.observations[id] = observation{clock: s.Clock, at: s.At}
	}
	return err
}

type Pending struct {
	Key  []byte
	Body []byte
}

func (j *Journal) Batch(limit int) ([]Pending, error) {
	rows := []Pending{}
	err := j.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(root).Bucket(pending).Cursor()
		for k, v := c.First(); k != nil && len(rows) < limit; k, v = c.Next() {
			rows = append(rows, Pending{Key: append([]byte(nil), k...), Body: append([]byte(nil), v...)})
		}
		return nil
	})
	return rows, err
}

func (j *Journal) PendingCount() (uint64, error) {
	var count uint64
	err := j.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(root).Get(pendingCount)
		if len(raw) != 8 {
			return errors.New("resource counter invalid")
		}
		count = binary.BigEndian.Uint64(raw)
		return nil
	})
	return count, err
}
func (j *Journal) Acknowledge(rows []Pending) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(root)
		pb := b.Bucket(pending)
		raw := b.Get(pendingCount)
		if len(raw) != 8 {
			return errors.New("resource counter invalid")
		}
		count := binary.BigEndian.Uint64(raw)
		for _, r := range rows {
			if raw := pb.Get(r.Key); raw != nil {
				if string(raw) != string(r.Body) {
					return errors.New("resource acknowledgement changed")
				}
				if count == 0 {
					return errors.New("resource counter underflow")
				}
				if err := pb.Delete(r.Key); err != nil {
					return err
				}
				count--
			}
		}
		// Closed cursors are tiny and are retained while any delivery remains.
		// This never collects allocation/Volume ownership or permits replay.
		if count == 0 {
			cb := tx.Bucket(root).Bucket(cursors)
			c := cb.Cursor()
			for k, v := c.First(); k != nil; k, v = c.Next() {
				var row Cursor
				if err := json.Unmarshal(v, &row); err != nil {
					return err
				}
				if row.State == "absent" {
					if err := c.Delete(); err != nil {
						return err
					}
				}
			}
		}
		n := make([]byte, 8)
		binary.BigEndian.PutUint64(n, count)
		return b.Put(pendingCount, n)
	})
}
