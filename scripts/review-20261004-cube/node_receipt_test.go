package allocation

import (
	"context"
	"encoding/json"
	"errors"
	bolt "go.etcd.io/bbolt"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type reviewFailOnceDB struct {
	*bolt.DB
	fail bool
}

func (d *reviewFailOnceDB) Update(fn func(*bolt.Tx) error) error {
	if d.fail {
		d.fail = false
		return errors.New("review: node receipt write unavailable")
	}
	return d.DB.Update(fn)
}

// Characterizes the baseline defect. Copy into Cubelet/pkg/allocation in an
// exported, fully patched source tree; never change the operator checkout.
func TestReviewCleanupReceiptLostAfterPhysicalDeletion(t *testing.T) {
	raw, err := bolt.Open(filepath.Join(t.TempDir(), "metadata.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	db := &reviewFailOnceDB{DB: raw}
	store, err := NewStore(db, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(store, "review-boot")
	id := Identity{ID: "a1000000-0000-4000-8000-000000000001", Digest: strings.Repeat("a", 64), NotAfter: time.Now().Add(time.Minute).UnixMilli(), BootID: "review-boot"}
	if _, err = manager.Create(context.Background(), id, time.Second, func(context.Context) (json.RawMessage, bool, error) {
		return json.RawMessage(`{"created":true}`), true, nil
	}); err != nil {
		t.Fatal(err)
	}
	physicalDeletes := 0
	_, err = manager.Close(context.Background(), id, func(context.Context, Record) (json.RawMessage, bool, error) {
		physicalDeletes++
		db.fail = true
		return json.RawMessage(`{"volumeReference":0}`), true, nil
	})
	if err == nil {
		t.Fatal("receipt write failure was not injected")
	}
	// The actual cleanup adapter takes this branch when exact node Observe sees
	// absence: return r.CleanupResult, true, nil. The first reply was never stored.
	r, err := manager.Close(context.Background(), id, func(_ context.Context, r Record) (json.RawMessage, bool, error) { return r.CleanupResult, true, nil })
	if err != nil {
		t.Fatal(err)
	}
	if r.Phase != "absent" || !r.Closed || len(r.CleanupResult) != 0 || physicalDeletes != 1 {
		t.Fatalf("unexpected baseline: %+v deletes=%d", r, physicalDeletes)
	}
	t.Log("review observation: confirmed absence has no original cleanup/Volume reply after one journal-write failure")
}
