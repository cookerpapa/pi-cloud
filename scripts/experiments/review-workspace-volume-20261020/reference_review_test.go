package volume

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/tencentcloud/CubeSandbox/Cubelet/plugins/volume/refcount"
	bolt "go.etcd.io/bbolt"
)

// Characterize the unchanged maintained patch. No KVM, host mount or production
// reference store is touched. referencePlugin comes from its pinned contract test.
func TestReviewRestartUnknownReferences(t *testing.T) {
	for _, shared := range []bool{false, true} {
		name := "last-holder"
		if shared {
			name = "shared-survivor"
		}
		t.Run(name, func(t *testing.T) {
			raw, err := bolt.Open(filepath.Join(t.TempDir(), "refs.db"), 0600, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			store, err := refcount.New(raw)
			if err != nil {
				t.Fatal(err)
			}
			p := &referencePlugin{}
			m := &Manager{byName: map[string]VolumePlugin{"test": p}, rcStore: store}
			ctx := context.Background()
			attach := func(id, volumeID string) error {
				_, e := m.Attach(ctx, &AttachRequest{Namespace: "default", VolumeID: volumeID, SandboxID: id, Driver: "test"})
				return e
			}
			if err := attach("lost", "review"); err != nil {
				t.Fatal(err)
			}
			live := map[string]struct{}{}
			if shared {
				if err := attach("survivor", "review"); err != nil {
					t.Fatal(err)
				}
				live["survivor"] = struct{}{}
			}
			recovered, err := store.RecoverRefCounts(live)
			if err != nil || recovered.StaleRefsRemoved != 1 {
				t.Fatal(recovered, err)
			}
			rec, exists, err := store.GetRecord("default", "review")
			if err != nil || !exists || !rec.Unknown || rec.Pending != nil {
				t.Fatal(rec, exists, err)
			}
			for i := 0; i < 3; i++ {
				state, err := m.ObserveReference(ctx, "default", "review")
				if err != nil || state.Confirmed {
					t.Fatal(state, err)
				}
			}
			if err := attach("new", "review"); err == nil {
				t.Fatal("expected held admission")
			}
			if shared {
				if err := m.Detach(ctx, &DetachRequest{Namespace: "default", VolumeID: "review", SandboxID: "survivor", Driver: "test"}); err == nil {
					t.Fatal("survivor detach unexpectedly escaped unknown state")
				}
			}
			if p.detaches != 0 {
				t.Fatal("unknown recovery unexpectedly called physical detach", p.detaches)
			}
			if err := attach("unrelated", "other-volume"); err != nil {
				t.Fatal(err)
			}
			t.Logf("case=%s removed_holders=%d remaining_holders=%d unknown=true pending_detach=false detach_calls=%d unrelated_volume_ok=true", name, recovered.StaleRefsRemoved, rec.Count, p.detaches)
		})
	}
}

func TestReviewRecordedPendingDetachStillConverges(t *testing.T) {
	raw, err := bolt.Open(filepath.Join(t.TempDir(), "refs.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	store, err := refcount.New(raw)
	if err != nil {
		t.Fatal(err)
	}
	p := &referencePlugin{}
	m := &Manager{byName: map[string]VolumePlugin{"test": p}, rcStore: store}
	ctx := context.Background()
	if _, err := m.Attach(ctx, &AttachRequest{Namespace: "default", VolumeID: "review", SandboxID: "a", Driver: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.BeginDetach("default", "review", "a", map[string]string{"path": "/test"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		state, err := m.ObserveReference(ctx, "default", "review")
		if err != nil || state.Count != 0 || !state.Confirmed {
			t.Fatal(state, err)
		}
	}
	if p.detaches != 1 {
		t.Fatal(p.detaches)
	}
	t.Log("ordinary_pending_detach_confirmed=true physical_detach_calls=1")
}
