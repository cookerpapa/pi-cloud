package picloudmetering

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"

	"encoding/json"
	bolt "go.etcd.io/bbolt"
)

var pendingBucket = []byte("pending-v1")
var activeBucket = []byte("active-v1")
var metaBucket = []byte("meta-v1")
var sizeKey = []byte("pending-bytes")
var errCapacity = errors.New("metering buffer at admission capacity")

type journal struct {
	db              *bolt.DB
	capacity        int64
	captureFailures atomic.Uint64
	producers       atomic.Int64
}

type deliveryState struct {
	pending, active int
}

func (j *journal) deliveryState() (deliveryState, error) {
	var state deliveryState
	err := j.db.View(func(tx *bolt.Tx) error {
		state.pending = tx.Bucket(pendingBucket).Stats().KeyN
		state.active = tx.Bucket(activeBucket).Stats().KeyN + int(j.producers.Load())
		return nil
	})
	return state, err
}

func openJournal(path string, capacity int64) (*journal, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	j := &journal{db: db, capacity: capacity}
	err = db.Update(func(tx *bolt.Tx) error {
		for _, name := range [][]byte{pendingBucket, activeBucket, metaBucket} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		// An admitted request is never replayed on restart. Its missing results
		// remain attributable even if the model had already processed the input.
		b := tx.Bucket(activeBucket)
		var keys [][]byte
		if err := b.ForEach(func(k, v []byte) error {
			var ctx attribution
			if err := json.Unmarshal(v, &ctx); err != nil {
				return err
			}
			if err := putEvent(tx, event{Kind: "interrupted", Context: ctx, OccurredAt: timestamp(time.Now())}); err != nil {
				return err
			}
			keys = append(keys, bytes.Clone(k))
			return nil
		}); err != nil {
			return err
		}
		for _, k := range keys {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	return j, nil
}

func storedBytes(tx *bolt.Tx) int64 {
	n, _ := strconv.ParseInt(string(tx.Bucket(metaBucket).Get(sizeKey)), 10, 64)
	return n
}
func changeSize(tx *bolt.Tx, delta int64) error {
	return tx.Bucket(metaBucket).Put(sizeKey, []byte(strconv.FormatInt(storedBytes(tx)+delta, 10)))
}
func (e event) id() string {
	id := e.Context.InvocationID + ":" + e.Kind
	if e.ExecutionID != "" {
		id += ":" + e.ExecutionID
	}
	return id
}
func putEvent(tx *bolt.Tx, e event) error {
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if len(raw) > 8192 {
		return errors.New("metering envelope too large")
	}
	key := []byte(e.id())
	b := tx.Bucket(pendingBucket)
	if previous := b.Get(key); previous != nil {
		if !bytes.Equal(raw, previous) {
			return errors.New("metering identity conflict")
		}
		return nil
	}
	if err := b.Put(key, raw); err != nil {
		return err
	}
	return changeSize(tx, int64(len(raw)+len(key)))
}
func (j *journal) admit(ctx attribution) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		// Reserve room for in-flight completions. The watermark rejects only
		// new work; an already admitted result is never dropped to regain space.
		if storedBytes(tx)+int64(tx.Bucket(activeBucket).Stats().KeyN+1)*32768 > j.capacity {
			return errCapacity
		}
		if tx.Bucket(activeBucket).Get([]byte(ctx.InvocationID)) != nil {
			return errors.New("invocation already admitted")
		}
		raw, err := json.Marshal(ctx)
		if err != nil {
			return err
		}
		if err := tx.Bucket(activeBucket).Put([]byte(ctx.InvocationID), raw); err != nil {
			return err
		}
		return putEvent(tx, event{Kind: "started", Context: ctx, OccurredAt: ctx.RequestedAt})
	})
}
func (j *journal) append(e event) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		if err := putEvent(tx, e); err != nil {
			return err
		}
		if e.Kind == "finished" {
			return tx.Bucket(activeBucket).Delete([]byte(e.Context.InvocationID))
		}
		return nil
	})
}

type pendingEvent struct{ key, raw []byte }

func (j *journal) batch() ([]pendingEvent, error) {
	var batch []pendingEvent
	err := j.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(pendingBucket).Cursor()
		for k, v := c.First(); k != nil && len(batch) < 128; k, v = c.Next() {
			batch = append(batch, pendingEvent{bytes.Clone(k), bytes.Clone(v)})
		}
		return nil
	})
	return batch, err
}
func (j *journal) acknowledge(batch []pendingEvent) error {
	return j.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(pendingBucket)
		for _, item := range batch {
			v := b.Get(item.key)
			if v == nil {
				continue
			}
			if !bytes.Equal(v, item.raw) {
				return fmt.Errorf("metering acknowledgement identity changed")
			}
			if err := changeSize(tx, -int64(len(v)+len(item.key))); err != nil {
				return err
			}
			if err := b.Delete(item.key); err != nil {
				return err
			}
		}
		return nil
	})
}
