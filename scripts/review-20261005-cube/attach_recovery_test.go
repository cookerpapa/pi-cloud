// Review-only characterization; copy into the exported Cubelet volume package.
package volume_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tencentcloud/CubeSandbox/Cubelet/plugins/volume"
	"github.com/tencentcloud/CubeSandbox/Cubelet/plugins/volume/binary"
	"github.com/tencentcloud/CubeSandbox/Cubelet/plugins/volume/refcount"
	bolt "go.etcd.io/bbolt"
)

func TestReviewCancelledAttachCannotRecoverWithActualPosixPlugin(t *testing.T) {
	path := os.Getenv("PI_CLOUD_REVIEW_VOLUME_PLUGIN")
	if path == "" {
		t.Fatal("explicit PiCloud POSIX script required")
	}
	db, err := bolt.Open(filepath.Join(t.TempDir(), "refs.db"), 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	refs, err := refcount.New(db)
	if err != nil {
		t.Fatal(err)
	}
	p := binary.New("review-posix")
	if err = p.Init(context.Background(), volume.PluginConfig{BinaryPath: path}); err != nil {
		t.Fatal(err)
	}
	m := volume.Global()
	m.Register(p)
	m.SetRefCountStore(refs)
	id := "pcw-" + strings.Repeat("a", 48)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = m.Attach(ctx, &volume.AttachRequest{Namespace: "default", VolumeID: id, SandboxID: "review-one", Driver: p.Name(), VolumeBaseDir: "/data/cube-shared/volume"})
	if err == nil {
		t.Fatal("cancelled attach unexpectedly completed")
	}
	pending, ok, err := refs.GetRecord("default", id)
	if err != nil || !ok || pending.Pending == nil || len(pending.Pending.Metadata) != 0 {
		t.Fatal(pending, ok, err)
	}
	for i := 0; i < 3; i++ {
		state, e := m.ObserveReference(context.Background(), "default", id)
		if e != nil || state.Confirmed || state.Count != 0 {
			t.Fatal(state, e)
		}
	}
	// The precise wire used by recovery cannot be accepted by the real plugin.
	err = p.Detach(context.Background(), &volume.DetachRequest{Namespace: "default", VolumeID: id, SandboxID: "review-one", Driver: p.Name(), Metadata: nil, RefCount: 0})
	if err == nil {
		t.Fatal("nil metadata unexpectedly accepted")
	}
	// The established POSIX metadata works without touching any Workspace bytes.
	if err = p.Detach(context.Background(), &volume.DetachRequest{Namespace: "default", VolumeID: id, SandboxID: "review-one", Driver: p.Name(), Metadata: map[string]string{"driver": "picloud-posix-v2"}, RefCount: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Attach(context.Background(), &volume.AttachRequest{Namespace: "default", VolumeID: id, SandboxID: "review-two", Driver: p.Name(), VolumeBaseDir: "/data/cube-shared/volume"}); err == nil {
		t.Fatal("expected blocked subsequent attach")
	}
	t.Log("reproduced: cancelled Attach leaves zero holders but unrecoverable nil detach metadata; actual POSIX plugin refuses every recovery attempt")
}
