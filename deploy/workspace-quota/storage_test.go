package quota

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func storageFixture(t *testing.T) (*Manager, StorageRequest, string) {
	t.Helper()
	m, err := NewManager(t.TempDir(), "storage-fixture", newFake())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	i := Identity{TenantID: uuid.NewString(), WorkspaceID: uuid.NewString(), Generation: strings.Repeat("c", 64)}
	i.VolumeID = volumeID(i.TenantID, i.WorkspaceID)
	return m, StorageRequest{Identity: i, PoolID: "owned-fixture"}, filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)
}

func TestWorkspaceStorageIdentityAndLostReply(t *testing.T) {
	m, request, root := storageFixture(t)
	ctx := context.Background()
	prepare := StoragePrepareRequest{StorageRequest: request, Initialize: true}
	first, err := m.PrepareStorage(ctx, prepare)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Ready || first.Generation != request.Generation {
		t.Fatal(first)
	}
	path := filepath.Join(root, "workspace", "original.txt")
	if err = os.WriteFile(path, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	second, err := m.PrepareStorage(ctx, prepare)
	if err != nil || second != first {
		t.Fatalf("retry changed identity: %+v %v", second, err)
	}
	changed := prepare
	changed.Generation = strings.Repeat("d", 64)
	if _, err = m.PrepareStorage(ctx, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed generation accepted: %v", err)
	}
	changed = prepare
	changed.PoolID = "other-node-pool"
	if _, err = m.PrepareStorage(ctx, changed); !errors.Is(err, ErrConflict) {
		t.Fatalf("wrong pool accepted: %v", err)
	}
	if body, err := os.ReadFile(path); err != nil || string(body) != "keep" {
		t.Fatal("existing bytes changed")
	}
}

func TestWorkspaceStorageNeverRecreatesKnownMissingBytes(t *testing.T) {
	m, request, root := storageFixture(t)
	ctx := context.Background()
	if _, err := m.PrepareStorage(ctx, StoragePrepareRequest{StorageRequest: request, Initialize: true}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "workspace")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.PrepareStorage(ctx, StoragePrepareRequest{StorageRequest: request}); err == nil {
		t.Fatal("missing retained bytes were recreated")
	}
	if _, err := os.Stat(filepath.Join(root, "workspace")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty substitute appeared")
	}
}

func TestWorkspaceStorageAdoptsOnlyTheRecordedGeneration(t *testing.T) {
	m, request, root := storageFixture(t)
	ctx := context.Background()
	meta := filepath.Join(root, ".pi-cloud-runtime")
	if err := os.MkdirAll(filepath.Join(meta, "attachments"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "workspace"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(meta, "identity"), []byte("pi-cloud-volume-v1\n"+request.VolumeID+"\n"+request.Generation+"\n"), 0400); err != nil {
		t.Fatal(err)
	}
	if _, err := m.PrepareStorage(ctx, StoragePrepareRequest{StorageRequest: request}); !errors.Is(err, ErrMissing) {
		t.Fatalf("unadopted layout was silently used: %v", err)
	}
	state, err := m.PrepareStorage(ctx, StoragePrepareRequest{StorageRequest: request, Adopt: true})
	if err != nil || !state.Ready {
		t.Fatalf("adoption failed: %+v %v", state, err)
	}
}

func TestWorkspaceStorageDeletionRequiresAdmissionAndExactHolds(t *testing.T) {
	m, request, root := storageFixture(t)
	ctx := context.Background()
	if _, err := m.PrepareStorage(ctx, StoragePrepareRequest{StorageRequest: request, Initialize: true}); err != nil {
		t.Fatal(err)
	}
	meta := filepath.Join(root, ".pi-cloud-runtime")
	path := filepath.Join(root, "workspace", "kept.txt")
	if err := os.WriteFile(path, []byte("keep"), 0000); err != nil {
		t.Fatal(err)
	}
	if err := m.DestroyStorage(ctx, request); err == nil {
		t.Fatal("deleted without admission")
	}
	marker := "pi-cloud-volume-delete-v1\n" + request.VolumeID + "\n" + request.Generation + "\n"
	if err := os.WriteFile(filepath.Join(meta, "delete-authorized"), []byte(marker), 0400); err != nil {
		t.Fatal(err)
	}
	hold := filepath.Join(meta, "attachments", "original-hold")
	if err := os.WriteFile(hold, []byte("unconfirmed"), 0400); err != nil {
		t.Fatal(err)
	}
	if err := m.DestroyStorage(ctx, request); !errors.Is(err, ErrClosing) {
		t.Fatalf("unresolved holder did not block: %v", err)
	}
	if err := os.Remove(hold); err != nil {
		t.Fatal(err)
	}
	stale := request
	stale.Generation = strings.Repeat("e", 64)
	if err := m.DestroyStorage(ctx, stale); !errors.Is(err, ErrConflict) {
		t.Fatal("stale delete accepted")
	}
	if err := m.DestroyStorage(ctx, request); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "workspace")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("Workspace remains")
	}
	if err := m.DestroyStorage(ctx, request); err != nil {
		t.Fatalf("delete retry failed: %v", err)
	}
}
