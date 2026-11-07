// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	resourceusage "github.com/cookerpapa/pi-cloud/resource-metering"
	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"
)

type fakeKernel struct {
	mu       sync.Mutex
	projects map[string]uint32
	quotas   map[uint32]KernelQuota
	sets     int
	afterSet bool
}

func newFake() *fakeKernel {
	return &fakeKernel{projects: map[string]uint32{}, quotas: map[uint32]KernelQuota{}}
}
func (*fakeKernel) Pool(*os.File) (PoolInfo, error) {
	return PoolInfo{ID: "owned-fixture", TotalBytes: 1024 << 30, AvailableBytes: 1000 << 30}, nil
}
func (*fakeKernel) MaximumProject(*os.File) (uint32, error) { return 0, nil }
func (k *fakeKernel) Read(_ *os.File, id uint32) (KernelQuota, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	q := k.quotas[id]
	q.ProjectID = id
	return q, nil
}
func (k *fakeKernel) Set(_ *os.File, id uint32, bytes uint64) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	q := k.quotas[id]
	q.ProjectID = id
	q.CapacityBytes = bytes
	k.quotas[id] = q
	k.sets++
	if k.afterSet {
		k.afterSet = false
		return errors.New("interrupted after kernel effect")
	}
	return nil
}
func fileKey(f *os.File) string {
	info, _ := f.Stat()
	s := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", s.Dev, s.Ino)
}
func (k *fakeKernel) Project(f *os.File) (uint32, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v := k.projects[fileKey(f)]
	if v == 0 {
		return 0, syscall.ENODATA
	}
	return v, nil
}
func (k *fakeKernel) Assign(f *os.File, id uint32) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	key := fileKey(f)
	if k.projects[key] != 0 && k.projects[key] != id {
		return ErrConflict
	}
	k.projects[key] = id
	return nil
}
func volumeFixture(t *testing.T, root string) Identity {
	t.Helper()
	i := Identity{TenantID: uuid.NewString(), WorkspaceID: uuid.NewString(), Generation: strings.Repeat("a", 64)}
	i.VolumeID = volumeID(i.TenantID, i.WorkspaceID)
	dir := filepath.Join(root, "picloud-posix-"+i.VolumeID)
	if err := os.MkdirAll(filepath.Join(dir, ".pi-cloud-runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "workspace"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".pi-cloud-runtime", "identity"), []byte("pi-cloud-volume-v1\n"+i.VolumeID+"\n"+i.Generation+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return i
}
func managerFixture(t *testing.T) (*Manager, *fakeKernel, Identity) {
	t.Helper()
	root := t.TempDir()
	k := newFake()
	m, err := NewManager(root, "owned-storage", k)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return m, k, volumeFixture(t, root)
}
func TestQuotaGrowthAndInterruptedApplyKeepOneProject(t *testing.T) {
	m, k, i := managerFixture(t)
	ctx := context.Background()
	r := EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}
	k.afterSet = true
	if _, err := m.Ensure(ctx, r); err == nil {
		t.Fatal("interruption disappeared")
	}
	first, err := m.lookup(i.VolumeID)
	if err != nil || first == nil || first.Applied {
		t.Fatal("pending receipt missing")
	}
	snap, err := m.Ensure(ctx, r)
	if err != nil || snap.CapacityBytes != r.CapacityBytes || snap.State != "ready" {
		t.Fatalf("retry failed: %+v %v", snap, err)
	}
	recovered, _ := m.lookup(i.VolumeID)
	if recovered.ProjectID != first.ProjectID {
		t.Fatal("retry allocated a second project")
	}
	calls := k.sets
	if _, err = m.Ensure(ctx, r); err != nil || k.sets != calls {
		t.Fatal("acknowledged retry repeated kernel mutation")
	}
	r.Revision = 2
	r.CapacityBytes = 64 << 30
	if _, err = m.Ensure(ctx, r); err != nil {
		t.Fatal(err)
	}
	stale := r
	stale.Revision = 1
	stale.CapacityBytes = 32 << 30
	if _, err = m.Ensure(ctx, stale); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision accepted: %v", err)
	}
	other := i
	other.Generation = strings.Repeat("b", 64)
	if _, err = m.Ensure(ctx, EnsureRequest{Identity: other, Revision: 3, CapacityBytes: 128 << 30}); err == nil {
		t.Fatal("changed generation accepted")
	}
}
func TestQuotaReleaseRequiresDirectoryAndInodeAbsence(t *testing.T) {
	m, k, i := managerFixture(t)
	ctx := context.Background()
	r := EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}
	if _, err := m.Ensure(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := m.Release(ctx, i); err == nil {
		t.Fatal("live directory released")
	}
	stored, _ := m.lookup(i.VolumeID)
	if err := os.RemoveAll(filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)); err != nil {
		t.Fatal(err)
	}
	q := k.quotas[stored.ProjectID]
	q.Inodes = 1
	k.quotas[stored.ProjectID] = q
	if err := m.Release(ctx, i); err == nil {
		t.Fatal("unlinked open inode released")
	}
	q.Inodes = 0
	k.quotas[stored.ProjectID] = q
	if err := m.Release(ctx, i); err != nil {
		t.Fatal(err)
	}
	actual, _ := k.Read(m.root, stored.ProjectID)
	if actual.CapacityBytes != 0 {
		t.Fatal("quota was not cleared")
	}
	if err := m.Release(ctx, i); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Ensure(ctx, r); !errors.Is(err, ErrMissing) {
		t.Fatal("late setter recreated a volume")
	}
	pending, _ := m.journal.Batch(128)
	if len(pending) < 2 {
		t.Fatal("terminal resource receipt missing")
	}
	if err := m.journal.Acknowledge(pending); err != nil {
		t.Fatal(err)
	}
	if err := m.Collect(ctx); err != nil {
		t.Fatal(err)
	}
	stored, _ = m.lookup(i.VolumeID)
	if stored != nil {
		t.Fatal("closed local quota receipt not collected")
	}
}
func TestQuotaDoesNotAdoptPopulatedUnenforcedTrees(t *testing.T) {
	m, _, i := managerFixture(t)
	original := filepath.Join(m.Root, "picloud-posix-"+i.VolumeID, "workspace", "keep")
	if err := os.WriteFile(original, []byte("owned bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := m.Ensure(context.Background(), EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30})
	if err == nil {
		t.Fatal("populated tree adopted without offline migration")
	}
	body, err := os.ReadFile(original)
	if err != nil || string(body) != "owned bytes" {
		t.Fatal("original bytes changed")
	}
}

type failingCaptureDatabase struct {
	*bolt.DB
	fail bool
}

func (db *failingCaptureDatabase) Update(update func(*bolt.Tx) error) error {
	if db.fail {
		return errors.New("owned receipt storage failure")
	}
	return db.DB.Update(update)
}

func TestSamplerAdoptsPublishedEnforcementWithoutRepeatingSetter(t *testing.T) {
	m, k, i := managerFixture(t)
	ctx := context.Background()
	request := EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}
	if _, err := m.Ensure(ctx, request); err != nil {
		t.Fatal(err)
	}
	r, _ := m.lookup(i.VolumeID)
	enforcedAt := r.EnforcedAt
	if enforcedAt == 0 || r.AcceptedAt == 0 {
		t.Fatal("source enforcement evidence was not persisted")
	}
	// The immutable marker reached disk, but the final Applied save did not.
	r.Applied, r.EnforcedAt = false, 0
	if err := m.save(r); err != nil {
		t.Fatal(err)
	}
	sets := k.sets
	if err := m.Sample(ctx); err != nil {
		t.Fatal(err)
	}
	r, _ = m.lookup(i.VolumeID)
	if !r.Applied || r.EnforcedAt != enforcedAt || k.sets != sets {
		t.Fatalf("sampler did not adopt the original completed application: %+v", r)
	}
	request.Revision = 2
	request.CapacityBytes = 64 << 30
	if _, err := m.Ensure(ctx, request); err != nil {
		t.Fatal(err)
	}
	r, _ = m.lookup(i.VolumeID)
	if r.EnforcedAt != enforcedAt {
		t.Fatal("growth changed the Volume's initial source timestamp")
	}
}

func TestInterruptedQuotaClearRecoversFromZeroKernelState(t *testing.T) {
	m, k, i := managerFixture(t)
	ctx := context.Background()
	if _, err := m.Ensure(ctx, EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)); err != nil {
		t.Fatal(err)
	}
	k.afterSet = true
	if err := m.Release(ctx, i); err == nil {
		t.Fatal("interrupted kernel clear unexpectedly acknowledged")
	}
	r, _ := m.lookup(i.VolumeID)
	if r.Released || r.ReleaseStarted == 0 || r.ReleasedCapacity == 0 {
		t.Fatal("clear intent was lost")
	}
	sets := k.sets
	if err := m.Release(ctx, i); err != nil {
		t.Fatal(err)
	}
	r, _ = m.lookup(i.VolumeID)
	if !r.Released || !r.ReleaseUncertain || !r.MeteringClosed || sets != k.sets {
		t.Fatalf("clear recovery repeated effects or lost its uncertainty: %+v", r)
	}
}

func TestPendingQuotaCanCloseBeforeFirstKernelMutation(t *testing.T) {
	m, _, i := managerFixture(t)
	project, err := m.allocate()
	if err != nil {
		t.Fatal(err)
	}
	r := &record{EnsureRequest: EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}, ProjectID: project, AcceptedAt: time.Now().UnixMilli()}
	if err = m.save(r); err != nil {
		t.Fatal(err)
	}
	if err = os.RemoveAll(filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)); err != nil {
		t.Fatal(err)
	}
	if err = m.Release(context.Background(), i); err != nil {
		t.Fatal(err)
	}
	r, _ = m.lookup(i.VolumeID)
	if !r.Released || !r.MeteringClosed {
		t.Fatal("never-applied quota prevented confirmed physical cleanup")
	}
	rows, _ := m.journal.Batch(128)
	if len(rows) != 1 {
		t.Fatal("accepted-source coverage was discarded")
	}
	var event resourceusage.Event
	if err := json.Unmarshal(rows[0].Body, &event); err != nil || event.Quality != "unconfirmed" || event.State != "absent" {
		t.Fatalf("pending admission was charged or lost: %+v %v", event, err)
	}
}

func TestFailedFirstCaptureSurvivesDeletionAndSourceRestart(t *testing.T) {
	m, _, i := managerFixture(t)
	storage := &failingCaptureDatabase{DB: m.db}
	journal, err := resourceusage.New(storage, "owned-storage", m.boot, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	m.journal = journal
	storage.fail = true
	ctx := context.Background()
	if _, err := m.Ensure(ctx, EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30}); err != nil {
		t.Fatal("receipt outage prevented capacity application", err)
	}
	r, _ := m.lookup(i.VolumeID)
	start := r.EnforcedAt
	if err := os.RemoveAll(filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)); err != nil {
		t.Fatal(err)
	}
	if err := m.Release(ctx, i); err != nil {
		t.Fatal("receipt outage prevented physical cleanup", err)
	}
	r, _ = m.lookup(i.VolumeID)
	if !r.Released || r.MeteringClosed {
		t.Fatal("failed terminal receipt was marked committed")
	}
	end := r.ReleasedAt
	if err := m.Collect(ctx); err != nil {
		t.Fatal(err)
	}
	if r, _ = m.lookup(i.VolumeID); r == nil {
		t.Fatal("source evidence was collected before its terminal receipt")
	}
	// Drop all in-memory failed-capture evidence as a real source restart does.
	m.journal, err = resourceusage.New(m.db, "owned-storage", "replacement-boot", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Sample(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := m.journal.Batch(128)
	if err != nil || len(rows) != 1 {
		t.Fatalf("missing recovered terminal receipt: %d %v", len(rows), err)
	}
	var event resourceusage.Event
	if err := json.Unmarshal(rows[0].Body, &event); err != nil {
		t.Fatal(err)
	}
	from, _ := time.Parse(time.RFC3339Nano, event.From)
	to, _ := time.Parse(time.RFC3339Nano, event.To)
	if event.State != "absent" || event.Quality != "unconfirmed" || from.UnixMilli() != start || to.UnixMilli() != end {
		t.Fatalf("known failed-capture lifetime was charged or lost its bounds: %+v", event)
	}
	r, _ = m.lookup(i.VolumeID)
	if !r.MeteringClosed {
		t.Fatal("source checkpoint did not commit with its receipt")
	}
	if err := m.journal.Acknowledge(rows); err != nil {
		t.Fatal(err)
	}
	if err := m.Collect(ctx); err != nil {
		t.Fatal(err)
	}
	if r, _ = m.lookup(i.VolumeID); r != nil {
		t.Fatal("delivered and physically absent quota was retained")
	}
}

type blockedSetter struct {
	*fakeKernel
	entered chan struct{}
	resume  chan struct{}
}

func (k *blockedSetter) Set(dir *os.File, project uint32, capacity uint64) error {
	if capacity == 32<<30 {
		close(k.entered)
		<-k.resume
	}
	return k.fakeKernel.Set(dir, project, capacity)
}

func TestCancelledSetterRetainsExclusionUntilItsKernelCallReturns(t *testing.T) {
	root := t.TempDir()
	k := &blockedSetter{fakeKernel: newFake(), entered: make(chan struct{}), resume: make(chan struct{})}
	m, err := NewManager(root, "owned-storage", k)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	i := volumeFixture(t, root)
	oldCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oldDone := make(chan error, 1)
	go func() {
		_, err := m.Ensure(oldCtx, EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 32 << 30})
		oldDone <- err
	}()
	<-k.entered
	cancel()
	newDone := make(chan error, 1)
	go func() {
		_, err := m.Ensure(context.Background(), EnsureRequest{Identity: i, Revision: 2, CapacityBytes: 64 << 30})
		newDone <- err
	}()
	select {
	case err := <-newDone:
		close(k.resume)
		<-oldDone
		t.Fatal("replacement escaped the still-running setter's lock", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(k.resume)
	if err := <-oldDone; err != nil {
		t.Fatal(err)
	}
	if err := <-newDone; err != nil {
		t.Fatal(err)
	}
	snap, err := m.Read(context.Background(), i)
	if err != nil || snap.Revision != 2 || snap.CapacityBytes != 64<<30 {
		t.Fatalf("old setter clobbered the replacement: %+v %v", snap, err)
	}
}
