// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	resourceusage "github.com/cookerpapa/pi-cloud/resource-metering"
	"github.com/google/uuid"
	bolt "go.etcd.io/bbolt"
)

const EnforcementFile = "quota-enforced-v1"
const safeMaximum = uint64(9_007_199_254_740_991)

var volumePattern = regexp.MustCompile(`^pcw-[0-9a-f]{48}$`)
var generationPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var recordsBucket = []byte("workspace-quotas.v1")
var metaBucket = []byte("workspace-quota-meta.v1")
var ErrConflict = errors.New("workspace quota identity or revision changed")
var ErrClosing = errors.New("workspace volume is closing")
var ErrMissing = errors.New("workspace volume is unavailable")

type Identity struct {
	TenantID    string `json:"tenantId"`
	WorkspaceID string `json:"workspaceId"`
	VolumeID    string `json:"volumeId"`
	Generation  string `json:"generation"`
}
type EnsureRequest struct {
	Identity
	Revision      uint64 `json:"revision"`
	CapacityBytes uint64 `json:"capacityBytes"`
}
type Snapshot struct {
	State         string `json:"state"`
	CapacityBytes uint64 `json:"capacityBytes"`
	UsedBytes     uint64 `json:"usedBytes"`
	Revision      uint64 `json:"revision"`
}
type enforcement struct {
	Identity
	Version      int    `json:"version"`
	ProjectID    uint32 `json:"projectId"`
	FilesystemID string `json:"filesystemId"`
	EnforcedAt   int64  `json:"enforcedAt"`
}
type record struct {
	EnsureRequest
	ProjectID        uint32 `json:"projectId"`
	AcceptedAt       int64  `json:"acceptedAt"`
	EnforcedAt       int64  `json:"enforcedAt,omitempty"`
	Applied          bool   `json:"applied"`
	Released         bool   `json:"released"`
	ReleasedAt       int64  `json:"releasedAt,omitempty"`
	ReleasedCapacity uint64 `json:"releasedCapacity,omitempty"`
	ReleaseStarted   int64  `json:"releaseStarted,omitempty"`
	ReleaseUncertain bool   `json:"releaseUncertain,omitempty"`
	MeteringClosed   bool   `json:"meteringClosed,omitempty"`
}
type Manager struct {
	root    *os.File
	Root    string
	kernel  Kernel
	db      *bolt.DB
	journal *resourceusage.Journal
	poolID  string
	boot    string
}

func volumeID(tenant, workspace string) string {
	sum := sha256.Sum256([]byte("pi-cloud.workspace-volume.v1\x00" + tenant + "\x00" + workspace))
	return "pcw-" + hex.EncodeToString(sum[:])[:48]
}
func (i Identity) validate() error {
	if _, err := uuid.Parse(i.TenantID); err != nil {
		return ErrConflict
	}
	if _, err := uuid.Parse(i.WorkspaceID); err != nil {
		return ErrConflict
	}
	if !volumePattern.MatchString(i.VolumeID) || !generationPattern.MatchString(i.Generation) || volumeID(i.TenantID, i.WorkspaceID) != i.VolumeID {
		return ErrConflict
	}
	return nil
}
func directory(path string) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}
func NewManager(root, source string, kernel Kernel) (*Manager, error) {
	if !filepath.IsAbs(root) || source == "" {
		return nil, errors.New("invalid quota configuration")
	}
	dir, err := directory(root)
	if err != nil {
		return nil, err
	}
	pool, err := kernel.Pool(dir)
	if err != nil {
		dir.Close()
		return nil, fmt.Errorf("quota-enabled XFS required: %w", err)
	}
	state := filepath.Join(root, ".pi-cloud-quota")
	if err = os.Mkdir(state, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		dir.Close()
		return nil, err
	}
	stateDir, err := directory(state)
	if err != nil {
		dir.Close()
		return nil, err
	}
	stateDir.Close()
	dbPath := filepath.Join(state, "state.db")
	if _, err = os.Lstat(dbPath); errors.Is(err, os.ErrNotExist) {
		entries, e := os.ReadDir(root)
		if e != nil {
			dir.Close()
			return nil, e
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "picloud-posix-pcw-") {
				if _, e = os.Lstat(filepath.Join(root, entry.Name(), ".pi-cloud-runtime", EnforcementFile)); e == nil {
					dir.Close()
					return nil, errors.New("quota metadata is missing for an enforced pool")
				}
			}
		}
	} else if err != nil {
		dir.Close()
		return nil, err
	} else if info, e := os.Lstat(dbPath); e != nil || !info.Mode().IsRegular() {
		dir.Close()
		return nil, errors.New("invalid quota metadata file")
	}
	db, err := bolt.Open(dbPath, 0600, &bolt.Options{Timeout: 5 * time.Second})
	if err != nil {
		dir.Close()
		return nil, err
	}
	fail := func(err error) (*Manager, error) { db.Close(); dir.Close(); return nil, err }
	var fresh, needsSequence bool
	err = db.Update(func(tx *bolt.Tx) error {
		meta, e := tx.CreateBucketIfNotExists(metaBucket)
		if e != nil {
			return e
		}
		existing := meta.Get([]byte("filesystem"))
		fresh = existing == nil
		needsSequence = meta.Get([]byte("sequence-initialized")) == nil
		if !fresh && string(existing) != pool.ID {
			return errors.New("quota filesystem identity changed")
		}
		if fresh {
			if e = meta.Put([]byte("filesystem"), []byte(pool.ID)); e != nil {
				return e
			}
		}
		_, e = tx.CreateBucketIfNotExists(recordsBucket)
		return e
	})
	if err != nil {
		return fail(err)
	}
	if needsSequence {
		maximum, e := kernel.MaximumProject(dir)
		if e != nil {
			return fail(e)
		}
		err = db.Update(func(tx *bolt.Tx) error {
			b := tx.Bucket(recordsBucket)
			if err := b.SetSequence(max(b.Sequence(), uint64(max(maximum, 1000)))); err != nil {
				return err
			}
			return tx.Bucket(metaBucket).Put([]byte("sequence-initialized"), []byte{1})
		})
		if err != nil {
			return fail(err)
		}
	}
	boot := uuid.NewString()
	journal, err := resourceusage.New(db, source, boot, time.Now())
	if err != nil {
		return fail(err)
	}
	return &Manager{root: dir, Root: root, kernel: kernel, db: db, journal: journal, poolID: pool.ID, boot: boot}, nil
}
func (m *Manager) Close() error {
	err := m.db.Close()
	closeErr := m.root.Close()
	return errors.Join(err, closeErr)
}
func (m *Manager) Pool() (PoolInfo, error) {
	named, err := os.Stat(m.Root)
	if err != nil {
		return PoolInfo{}, err
	}
	opened, err := m.root.Stat()
	if err != nil {
		return PoolInfo{}, err
	}
	if !os.SameFile(named, opened) {
		return PoolInfo{}, errors.New("quota mount identity changed")
	}

	info, err := m.kernel.Pool(m.root)
	if err != nil {
		return info, err
	}
	if info.ID != m.poolID {
		return info, errors.New("quota filesystem changed")
	}
	return info, nil
}
func (m *Manager) lookup(id string) (*record, error) {
	var r *record
	err := m.db.View(func(tx *bolt.Tx) error {
		raw := tx.Bucket(recordsBucket).Get([]byte(id))
		if raw == nil {
			return nil
		}
		r = &record{}
		return json.Unmarshal(raw, r)
	})
	return r, err
}
func (m *Manager) save(r *record) error {
	body, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return m.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(recordsBucket).Put([]byte(r.VolumeID), body) })
}
func (m *Manager) allocate() (uint32, error) {
	var id uint64
	err := m.db.Update(func(tx *bolt.Tx) error { var e error; id, e = tx.Bucket(recordsBucket).NextSequence(); return e })
	if err != nil {
		return 0, err
	}
	if id > uint64(^uint32(0)) {
		return 0, errors.New("project ID space exhausted")
	}
	return uint32(id), nil
}

type heldVolume struct {
	root, metadata *os.File
	locks          []*os.File
	path           string
}

func (h *heldVolume) close() {
	for i := len(h.locks) - 1; i >= 0; i-- {
		h.locks[i].Close()
	}
	h.metadata.Close()
	h.root.Close()
}
func fdpath(f *os.File, name string) string { return fmt.Sprintf("/proc/self/fd/%d/%s", f.Fd(), name) }
func lockFile(ctx context.Context, path string, shared bool) (*os.File, error) {
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	mode := syscall.LOCK_EX
	if shared {
		mode = syscall.LOCK_SH
	}
	for {
		if err = syscall.Flock(fd, mode|syscall.LOCK_NB); err == nil {
			return file, nil
		}
		if err != syscall.EAGAIN && err != syscall.EWOULDBLOCK {
			file.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}
func (m *Manager) hold(ctx context.Context, i Identity, mutation bool) (*heldVolume, error) {
	if err := i.validate(); err != nil {
		return nil, err
	}
	path := filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)
	root, err := directory(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrMissing
	}
	if err != nil {
		return nil, err
	}
	meta, err := directory(fdpath(root, ".pi-cloud-runtime"))
	if err != nil {
		root.Close()
		return nil, err
	}
	h := &heldVolume{root: root, metadata: meta, path: path}
	fail := func(err error) (*heldVolume, error) { h.close(); return nil, err }
	admission, err := lockFile(ctx, fdpath(meta, "gateway.lock"), true)
	if err != nil {
		return fail(err)
	}
	h.locks = append(h.locks, admission)
	if mutation {
		lock, err := lockFile(ctx, fdpath(meta, "quota.lock"), false)
		if err != nil {
			return fail(err)
		}
		h.locks = append(h.locks, lock)
	}
	raw, err := readSmall(fdpath(meta, "identity"))
	if err != nil {
		return fail(err)
	}
	if string(raw) != "pi-cloud-volume-v1\n"+i.VolumeID+"\n"+i.Generation+"\n" {
		return fail(ErrConflict)
	}
	if _, err = os.Lstat(fdpath(meta, "delete-authorized")); err == nil {
		return fail(ErrClosing)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	// Verify that pathname replacement did not give these locks a stale directory.
	named, err := os.Stat(path)
	if err != nil {
		return fail(err)
	}
	opened, err := root.Stat()
	if err != nil {
		return fail(err)
	}
	if !os.SameFile(named, opened) {
		return fail(ErrConflict)
	}
	return h, nil
}
func readSmall(path string) ([]byte, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return nil, ErrConflict
	}
	return io.ReadAll(io.LimitReader(file, 4097))
}
func (m *Manager) marker(h *heldVolume, i Identity) (*enforcement, error) {
	raw, err := readSmall(fdpath(h.metadata, EnforcementFile))
	if err != nil {
		return nil, err
	}
	var mark enforcement
	if err = json.Unmarshal(raw, &mark); err != nil {
		return nil, err
	}
	if mark.Version != 1 || mark.Identity != i || mark.FilesystemID != m.poolID || mark.ProjectID == 0 || mark.EnforcedAt <= 0 {
		return nil, ErrConflict
	}
	return &mark, nil
}
func (m *Manager) publishMarker(h *heldVolume, r *record) error {
	if old, e := m.marker(h, r.Identity); e == nil {
		if old.ProjectID != r.ProjectID || (r.EnforcedAt != 0 && r.EnforcedAt != old.EnforcedAt) {
			return ErrConflict
		}
		r.EnforcedAt = old.EnforcedAt
		return nil
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if r.EnforcedAt == 0 {
		r.EnforcedAt = time.Now().UnixMilli()
	}
	mark := enforcement{Identity: r.Identity, Version: 1, ProjectID: r.ProjectID, FilesystemID: m.poolID, EnforcedAt: r.EnforcedAt}
	body, err := json.Marshal(mark)
	if err != nil {
		return err
	}
	path := fdpath(h.metadata, ".quota-"+uuid.NewString())
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	defer os.Remove(path)
	// The gateway is unprivileged (1000:1000), including after an offline
	// migration helper ran with root's primary group.
	if err = file.Chown(1000, 1000); err != nil {
		file.Close()
		return err
	}
	if _, err = file.Write(body); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Link(path, fdpath(h.metadata, EnforcementFile)); err != nil {
		return err
	}
	return h.metadata.Sync()
}
func empty(dir *os.File) error {
	names, err := dir.Readdirnames(1)
	if err != nil && err != io.EOF {
		return err
	}
	if len(names) != 0 {
		return errors.New("unenforced workspace must be migrated while quiescent")
	}
	return nil
}
func (m *Manager) projectTree(dir *os.File, id uint32) error {
	existing, err := m.kernel.Project(dir)
	if err == nil && existing == id {
		return nil
	}
	if err != nil && err != syscall.ENODATA {
		return err
	}
	if existing != 0 {
		return ErrConflict
	}
	if err = empty(dir); err != nil {
		return err
	}
	return m.kernel.Assign(dir, id)
}

func (m *Manager) Ensure(ctx context.Context, request EnsureRequest) (Snapshot, error) {
	if err := request.Identity.validate(); err != nil {
		return Snapshot{}, err
	}
	lock, err := m.stateLock(ctx, request.VolumeID, false)
	if err != nil {
		return Snapshot{}, err
	}
	defer lock.Close()
	return m.ensure(ctx, request)
}
func (m *Manager) ensure(ctx context.Context, request EnsureRequest) (Snapshot, error) {
	if request.Revision == 0 || request.Revision > safeMaximum || request.CapacityBytes < 4096 || request.CapacityBytes > safeMaximum || request.CapacityBytes%4096 != 0 {
		return Snapshot{}, errors.New("invalid workspace capacity")
	}
	pool, err := m.Pool()
	if err != nil {
		return Snapshot{}, err
	}
	if request.CapacityBytes > pool.TotalBytes {
		return Snapshot{}, errors.New("capacity exceeds storage pool size")
	}
	held, err := m.hold(ctx, request.Identity, true)
	if err != nil {
		return Snapshot{}, err
	}
	defer held.close()
	r, err := m.lookup(request.VolumeID)
	if err != nil {
		return Snapshot{}, err
	}
	if r != nil {
		if r.Identity != request.Identity || r.Released || request.Revision < r.Revision {
			return Snapshot{}, ErrConflict
		}
		if request.Revision == r.Revision && request.CapacityBytes != r.CapacityBytes {
			return Snapshot{}, ErrConflict
		}
		if request.CapacityBytes < r.CapacityBytes {
			return Snapshot{}, errors.New("workspace capacity can only grow")
		}
	} else {
		id, err := m.allocate()
		if err != nil {
			return Snapshot{}, err
		}
		r = &record{EnsureRequest: request, ProjectID: id, AcceptedAt: time.Now().UnixMilli()}
	}
	if r.Applied && r.Revision == request.Revision {
		actual, err := m.kernel.Read(m.root, r.ProjectID)
		mark, markErr := m.marker(held, r.Identity)
		if err == nil && markErr == nil && mark.ProjectID == r.ProjectID && r.EnforcedAt == mark.EnforcedAt && actual.CapacityBytes == request.CapacityBytes {
			return Snapshot{State: "ready", CapacityBytes: actual.CapacityBytes, UsedBytes: actual.UsedBytes, Revision: r.Revision}, nil
		}
	}
	if r.Applied {
		m.capture(r, time.Now(), "retained", 0)
	}
	r.EnsureRequest = request
	r.Applied = false
	if err = m.save(r); err != nil {
		return Snapshot{}, err
	}
	old, err := m.kernel.Read(m.root, r.ProjectID)
	if err != nil && err != syscall.ENOENT && err != syscall.ESRCH {
		return Snapshot{}, err
	}
	if old.CapacityBytes > request.CapacityBytes {
		return Snapshot{}, errors.New("kernel capacity exceeds the requested growth")
	}
	// Set a nonzero limit before assigning any inode to the new project.
	if err = m.kernel.Set(m.root, r.ProjectID, request.CapacityBytes); err != nil {
		return Snapshot{}, err
	}
	workspace, err := directory(fdpath(held.root, "workspace"))
	if err != nil {
		return Snapshot{}, err
	}
	defer workspace.Close()
	if err = m.projectTree(workspace, r.ProjectID); err != nil {
		return Snapshot{}, err
	}
	stagingPath := fdpath(held.metadata, "uploads-v1")
	if err = os.Mkdir(stagingPath, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return Snapshot{}, err
	}
	if err = os.Chown(stagingPath, 1000, 1000); err != nil {
		return Snapshot{}, err
	}
	staging, err := directory(stagingPath)
	if err != nil {
		return Snapshot{}, err
	}
	defer staging.Close()
	filesPath := fdpath(staging, "files")
	if err = os.Mkdir(filesPath, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return Snapshot{}, err
	}
	if err = os.Chown(filesPath, 1000, 1000); err != nil {
		return Snapshot{}, err
	}
	files, err := directory(filesPath)
	if err != nil {
		return Snapshot{}, err
	}
	defer files.Close()
	if err = m.projectTree(files, r.ProjectID); err != nil {
		return Snapshot{}, err
	}
	quota, err := m.kernel.Read(m.root, r.ProjectID)
	if err != nil {
		return Snapshot{}, err
	}
	if quota.CapacityBytes != request.CapacityBytes {
		return Snapshot{}, errors.New("kernel quota did not apply")
	}
	if err = m.publishMarker(held, r); err != nil {
		return Snapshot{}, err
	}
	r.Applied = true
	if err = m.save(r); err != nil {
		return Snapshot{}, err
	}
	m.capture(r, time.Now(), "retained", 0)
	return Snapshot{State: "ready", CapacityBytes: quota.CapacityBytes, UsedBytes: quota.UsedBytes, Revision: r.Revision}, nil
}

func (m *Manager) Read(ctx context.Context, i Identity) (Snapshot, error) {
	if err := i.validate(); err != nil {
		return Snapshot{}, err
	}
	lock, err := m.stateLock(ctx, i.VolumeID, true)
	if err != nil {
		return Snapshot{}, err
	}
	defer lock.Close()
	return m.read(ctx, i)
}
func (m *Manager) read(ctx context.Context, i Identity) (Snapshot, error) {
	if _, err := m.Pool(); err != nil {
		return Snapshot{}, err
	}
	h, err := m.hold(ctx, i, false)
	if err != nil {
		return Snapshot{}, err
	}
	defer h.close()
	marker, err := m.marker(h, i)
	if errors.Is(err, os.ErrNotExist) {
		return Snapshot{State: "pending"}, nil
	}
	if err != nil {
		return Snapshot{}, err
	}
	r, err := m.lookup(i.VolumeID)
	if err != nil {
		return Snapshot{}, err
	}
	if r == nil || r.Identity != i || r.ProjectID != marker.ProjectID {
		return Snapshot{}, ErrConflict
	}
	actual, err := m.kernel.Read(m.root, r.ProjectID)
	if err != nil {
		return Snapshot{}, err
	}
	if actual.CapacityBytes == 0 {
		return Snapshot{}, errors.New("workspace quota enforcement was removed")
	}
	state := "pending"
	if r.Applied && actual.CapacityBytes == r.CapacityBytes {
		state = "ready"
	}
	return Snapshot{State: state, CapacityBytes: actual.CapacityBytes, UsedBytes: actual.UsedBytes, Revision: r.Revision}, nil
}

func (m *Manager) Release(ctx context.Context, i Identity) error {
	if err := i.validate(); err != nil {
		return err
	}
	lock, err := m.stateLock(ctx, i.VolumeID, false)
	if err != nil {
		return err
	}
	defer lock.Close()
	return m.release(i)
}
func (m *Manager) ReleaseVolume(ctx context.Context, tenant, workspace, volume string) error {
	if _, err := uuid.Parse(tenant); err != nil {
		return ErrConflict
	}
	if _, err := uuid.Parse(workspace); err != nil {
		return ErrConflict
	}
	if volumeID(tenant, workspace) != volume {
		return ErrConflict
	}
	lock, err := m.stateLock(ctx, volume, false)
	if err != nil {
		return err
	}
	defer lock.Close()
	r, err := m.lookup(volume)
	if err != nil {
		return err
	}
	if r == nil {
		if _, err = os.Lstat(filepath.Join(m.Root, "picloud-posix-"+volume)); !errors.Is(err, os.ErrNotExist) {
			return errors.New("workspace directory absence is not confirmed")
		}
		return nil
	}
	if r.TenantID != tenant || r.WorkspaceID != workspace {
		return ErrConflict
	}
	return m.release(r.Identity)
}
func (m *Manager) release(i Identity) error {
	if _, err := m.Pool(); err != nil {
		return err
	}
	path := filepath.Join(m.Root, "picloud-posix-"+i.VolumeID)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return errors.New("workspace directory absence is not confirmed")
	}
	r, err := m.lookup(i.VolumeID)
	if err != nil {
		return err
	}
	if r == nil {
		return nil
	}
	if r.Identity != i {
		return ErrConflict
	}
	if r.Released {
		return nil
	}
	actual, err := m.kernel.Read(m.root, r.ProjectID)
	if err != nil {
		return err
	}
	if actual.UsedBytes != 0 || actual.Inodes != 0 {
		return errors.New("workspace quota still has physical references")
	}
	if actual.CapacityBytes > 0 {
		r.ReleasedCapacity = actual.CapacityBytes
		r.ReleaseStarted = time.Now().UnixMilli()
		if err = m.save(r); err != nil {
			return err
		}
		if err = m.kernel.Set(m.root, r.ProjectID, 0); err != nil {
			return err
		}
	} else {
		if r.ReleasedCapacity == 0 && r.ReleaseStarted == 0 && !r.Applied && r.EnforcedAt == 0 {
			// A pending admission can be cancelled before its first kernel Set.
			// The still-enforced filesystem has positively reported no quota or
			// accounted inode. Retain only unconfirmed accepted-source coverage.
			r.ReleasedCapacity = r.CapacityBytes
		} else if r.ReleasedCapacity == 0 || r.ReleaseStarted == 0 {
			return errors.New("quota release identity is unconfirmed")
		}
		r.ReleaseUncertain = true
	}
	r.Released = true
	r.ReleasedAt = time.Now().UnixMilli()
	if err = m.save(r); err != nil {
		return err
	}
	// Physical cleanup succeeds independently of accounting buffer availability.
	_ = m.closeMetering(r)

	return nil
}

func (m *Manager) capture(r *record, now time.Time, state string, end int64) error {
	quantity := r.CapacityBytes
	if state == "retained" {
		q, err := m.kernel.Read(m.root, r.ProjectID)
		if err != nil || q.CapacityBytes == 0 {
			state = "unknown"
		} else {
			quantity = q.CapacityBytes
		}
	}
	return m.journal.Capture(resourceusage.Sample{Resource: resourceusage.Identity{Kind: "workspace", ResourceID: r.VolumeID + ":" + r.Generation, TenantID: r.TenantID, WorkspaceID: r.WorkspaceID}, Quantity: resourceusage.Quantity{Kind: "workspace", CapacityBytes: int64(quantity)}, Incarnation: r.Generation, State: state, At: now.UnixMilli(), Clock: now, EndedAt: end, CoverageStartedAt: coverageStart(r)})
}

func coverageStart(r *record) int64 {
	if r.EnforcedAt > 0 {
		return r.EnforcedAt
	}
	return r.AcceptedAt
}

// Recover only a completed application, never replay a kernel setter from the
// sampler. The caller holds the per-Volume state mutation lock throughout.
func (m *Manager) adoptApplied(ctx context.Context, r *record) error {
	if _, err := m.Pool(); err != nil {
		return err
	}
	h, err := m.hold(ctx, r.Identity, false)
	if err != nil {
		return err
	}
	defer h.close()
	mark, err := m.marker(h, r.Identity)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if mark.ProjectID != r.ProjectID || (r.EnforcedAt != 0 && r.EnforcedAt != mark.EnforcedAt) {
		return ErrConflict
	}
	actual, err := m.kernel.Read(m.root, r.ProjectID)
	if err != nil {
		return err
	}
	if actual.CapacityBytes != r.CapacityBytes {
		return nil
	}
	r.Applied, r.EnforcedAt = true, mark.EnforcedAt
	return m.save(r)
}
func (m *Manager) Sample(ctx context.Context) error {
	rows := []record{}
	if err := m.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(recordsBucket).ForEach(func(_, body []byte) error {
			var row record
			if err := json.Unmarshal(body, &row); err != nil {
				return err
			}
			if !row.Released || !row.MeteringClosed {
				rows = append(rows, row)
			}
			return nil
		})
	}); err != nil {
		return err
	}
	var failures []error
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return err
		}
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		lock, err := m.stateLock(probe, row.VolumeID, false)
		if err != nil {
			cancel()
			failures = append(failures, err)
			continue
		}
		current, err := m.lookup(row.VolumeID)
		if err == nil && current != nil && current.Released && !current.MeteringClosed {
			err = m.closeMetering(current)
		}
		if err == nil && current != nil && !current.Released {
			var adoptionErr error
			if !current.Applied || current.EnforcedAt == 0 {
				adoptionErr = m.adoptApplied(probe, current)
			}
			state := "unknown"
			snap, readErr := m.read(probe, current.Identity)
			if adoptionErr == nil && readErr == nil && snap.State == "ready" {
				state = "retained"
			}
			err = errors.Join(adoptionErr, m.capture(current, time.Now(), state, 0))
		}
		lock.Close()
		cancel()
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func (m *Manager) Deliver(ctx context.Context, url, token string) error {
	return m.journal.Deliver(ctx, url, token)
}
func (m *Manager) PendingCount() (uint64, error) { return m.journal.PendingCount() }

func (m *Manager) stateLock(ctx context.Context, id string, shared bool) (*os.File, error) {
	if !volumePattern.MatchString(id) {
		return nil, ErrConflict
	}
	path := filepath.Join(m.Root, ".pi-cloud-quota", id+".lock")
	file, err := lockFile(ctx, path, shared)
	if err != nil {
		return nil, err
	}
	named, err := os.Lstat(path)
	if err != nil {
		file.Close()
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, err
	}
	if !named.Mode().IsRegular() || named.Size() != 0 || !os.SameFile(named, actual) {
		file.Close()
		return nil, ErrConflict
	}
	return file, nil
}
func (m *Manager) closeMetering(r *record) error {
	if !r.Released || coverageStart(r) <= 0 || r.ReleasedAt <= 0 || r.ReleasedCapacity == 0 {
		return errors.New("terminal quota coverage is unconfirmed")
	}
	reason := ""
	if r.ReleaseUncertain {
		reason = "collection_unavailable"
	}
	closed := *r
	closed.MeteringClosed = true
	body, err := json.Marshal(closed)
	if err != nil {
		return err
	}
	now := time.Now()
	err = m.journal.CaptureAndUpdate(resourceusage.Sample{Resource: resourceusage.Identity{Kind: "workspace", ResourceID: r.VolumeID + ":" + r.Generation, TenantID: r.TenantID, WorkspaceID: r.WorkspaceID}, Quantity: resourceusage.Quantity{Kind: "workspace", CapacityBytes: int64(r.ReleasedCapacity)}, Incarnation: r.Generation, State: "absent", At: now.UnixMilli(), Clock: now, EndedAt: r.ReleasedAt, UncertainReason: reason, CoverageStartedAt: coverageStart(r)}, func(tx *bolt.Tx) error {
		return tx.Bucket(recordsBucket).Put([]byte(r.VolumeID), body)
	})
	if err != nil {
		return err
	}
	*r = closed
	return nil
}
func (m *Manager) PendingClosures() (uint64, error) {
	var count uint64
	err := m.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(recordsBucket).ForEach(func(_, v []byte) error {
			var r record
			if err := json.Unmarshal(v, &r); err != nil {
				return err
			}
			if r.Released && !r.MeteringClosed {
				count++
			}
			return nil
		})
	})
	return count, err
}
func (m *Manager) Collect(ctx context.Context) error {
	count, err := m.journal.PendingCount()
	if err != nil || count != 0 {
		return err
	}
	if _, err = m.Pool(); err != nil {
		return err
	}
	candidates := []record{}
	if err = m.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(recordsBucket).ForEach(func(_, v []byte) error {
			var r record
			if err := json.Unmarshal(v, &r); err != nil {
				return err
			}
			if r.Released && r.MeteringClosed {
				candidates = append(candidates, r)
			}
			return nil
		})
	}); err != nil {
		return err
	}
	for _, candidate := range candidates {
		lock, err := m.stateLock(ctx, candidate.VolumeID, false)
		if err != nil {
			return err
		}
		err = func() error {
			r, err := m.lookup(candidate.VolumeID)
			if err != nil {
				return err
			}
			if r == nil || !r.Released || !r.MeteringClosed {
				return nil
			}
			if _, err = os.Lstat(filepath.Join(m.Root, "picloud-posix-"+r.VolumeID)); !errors.Is(err, os.ErrNotExist) {
				return nil
			}
			q, err := m.kernel.Read(m.root, r.ProjectID)
			if err != nil {
				return err
			}
			if q.CapacityBytes != 0 || q.UsedBytes != 0 || q.Inodes != 0 {
				return nil
			}
			// A concurrent closure may have committed its record and receipt
			// after the outer scan's empty-outbox observation.
			count, err := m.journal.PendingCount()
			if err != nil || count != 0 {
				return err
			}
			if err = m.db.Update(func(tx *bolt.Tx) error { return tx.Bucket(recordsBucket).Delete([]byte(r.VolumeID)) }); err != nil {
				return err
			}
			return os.Remove(filepath.Join(m.Root, ".pi-cloud-quota", r.VolumeID+".lock"))
		}()
		lock.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
