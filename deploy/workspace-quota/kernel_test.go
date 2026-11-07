// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestKernelRejectsAnUnenforcedFilesystem(t *testing.T) {
	dir, err := directory(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	_, err = (XFSKernel{}).Pool(dir)
	if err == nil {
		t.Skip("test directory already has enforced XFS quotas")
	}
	if !errors.Is(err, syscall.EOPNOTSUPP) && !errors.Is(err, syscall.EPERM) {
		t.Fatal(err)
	}
}

// The maintained privileged fixture supplies a disposable mounted XFS root.
// No production directory or quota is accepted implicitly.
func TestRealKernelEnforcesWritesAndGrowth(t *testing.T) {
	root := os.Getenv("PI_CLOUD_QUOTA_TEST_ROOT")
	if root == "" {
		t.Skip("owned XFS contract fixture required")
	}
	if os.Geteuid() != 0 {
		t.Fatal("kernel quota fixture requires root")
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		t.Fatal("fixture root missing")
	}
	m, err := NewManager(root, "owned-kernel-fixture", XFSKernel{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	i := volumeFixture(t, root)
	ctx := context.Background()
	req := EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 8 << 20}
	if _, err = m.Ensure(ctx, req); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(filepath.Join(root, "picloud-posix-"+i.VolumeID, "workspace", "data"), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	chunk := make([]byte, 1024*1024)
	var full error
	for n := 0; n < 16; n++ {
		if _, e := file.Write(chunk); e != nil {
			full = e
			break
		}
		if e := file.Sync(); e != nil {
			full = e
			break
		}
	}
	file.Close()
	if !errors.Is(full, syscall.EDQUOT) && !errors.Is(full, syscall.ENOSPC) {
		t.Fatalf("kernel failed to enforce capacity: %v", full)
	}
	req.Revision = 2
	req.CapacityBytes = 32 << 20
	if _, err = m.Ensure(ctx, req); err != nil {
		t.Fatal(err)
	}
	file, err = os.OpenFile(filepath.Join(root, "picloud-posix-"+i.VolumeID, "workspace", "data"), os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write(chunk); err != nil {
		t.Fatal("growth did not restore writing", err)
	}
	if err = file.Sync(); err != nil {
		t.Fatal(err)
	}
	file.Close()
}

func TestRealKernelUnusedAndClearedQuotasPermitCollection(t *testing.T) {
	root := os.Getenv("PI_CLOUD_QUOTA_TEST_ROOT")
	if root == "" {
		t.Skip("owned XFS contract fixture required")
	}
	m, err := NewManager(root, "owned-kernel-fixture", XFSKernel{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	unused, err := m.allocate()
	if err != nil {
		t.Fatal(err)
	}
	if q, err := m.kernel.Read(m.root, unused); err != nil || q.CapacityBytes != 0 || q.Inodes != 0 || q.UsedBytes != 0 {
		t.Fatalf("unused XFS dquot was not observed as empty: %+v %v", q, err)
	}
	i := volumeFixture(t, root)
	ctx := context.Background()
	if _, err := m.Ensure(ctx, EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 8 << 20}); err != nil {
		t.Fatal(err)
	}
	r, _ := m.lookup(i.VolumeID)
	if err := os.RemoveAll(filepath.Join(root, "picloud-posix-"+i.VolumeID)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err = m.Release(ctx, i); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("physical quota references did not settle", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if q, err := m.kernel.Read(m.root, r.ProjectID); err != nil || q.CapacityBytes != 0 || q.Inodes != 0 || q.UsedBytes != 0 {
		t.Fatalf("cleared XFS dquot was not observed as empty: %+v %v", q, err)
	}
	rows, err := m.journal.Batch(128)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.journal.Acknowledge(rows); err != nil {
		t.Fatal(err)
	}
	if err := m.Collect(ctx); err != nil {
		t.Fatal(err)
	}
	if r, _ := m.lookup(i.VolumeID); r != nil {
		t.Fatal("cleared real XFS quota could not be collected")
	}
	for _, stage := range []string{"before_first_set", "after_clear"} {
		t.Run(stage, func(t *testing.T) {
			i := volumeFixture(t, root)
			project, err := m.allocate()
			if err != nil {
				t.Fatal(err)
			}
			r := &record{EnsureRequest: EnsureRequest{Identity: i, Revision: 1, CapacityBytes: 8 << 20}, ProjectID: project, AcceptedAt: time.Now().UnixMilli()}
			if stage == "after_clear" {
				if err := m.kernel.Set(m.root, project, r.CapacityBytes); err != nil {
					t.Fatal(err)
				}
				r.ReleaseStarted = time.Now().UnixMilli()
				r.ReleasedCapacity = r.CapacityBytes
			}
			if err := m.save(r); err != nil {
				t.Fatal(err)
			}
			if stage == "after_clear" {
				if err := m.kernel.Set(m.root, project, 0); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.RemoveAll(filepath.Join(root, "picloud-posix-"+i.VolumeID)); err != nil {
				t.Fatal(err)
			}
			if err := m.Release(ctx, i); err != nil {
				t.Fatal("empty real quota blocked interrupted-source cleanup", err)
			}
			rows, err := m.journal.Batch(128)
			if err != nil {
				t.Fatal(err)
			}
			if err := m.journal.Acknowledge(rows); err != nil {
				t.Fatal(err)
			}
			if err := m.Collect(ctx); err != nil {
				t.Fatal(err)
			}
			if r, _ := m.lookup(i.VolumeID); r != nil {
				t.Fatal("interrupted quota ownership could not be collected")
			}
		})
	}
}

// The owned contract unmounts this image and remounts it through another loop
// device between calls. The persisted authority must follow the XFS UUID.
func TestRealKernelFilesystemIdentitySurvivesRemount(t *testing.T) {
	root := os.Getenv("PI_CLOUD_QUOTA_TEST_ROOT")
	expected := os.Getenv("PI_CLOUD_QUOTA_EXPECTED_UUID")
	if root == "" || expected == "" {
		t.Skip("owned remount fixture required")
	}
	m, err := NewManager(root, "owned-kernel-fixture", XFSKernel{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	info, err := m.kernel.Pool(m.root)
	if err != nil {
		t.Fatal(err)
	}
	if info.ID != expected {
		t.Fatalf("filesystem identity %s does not match on-disk UUID %s", info.ID, expected)
	}
}
