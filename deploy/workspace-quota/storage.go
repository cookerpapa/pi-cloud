// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const PoolIdentityFile = ".pi-cloud-workspace-pool"
const VolumePoolFile = "storage-pool"

type StorageRequest struct {
	Identity
	PoolID string `json:"poolId"`
}
type StoragePrepareRequest struct {
	StorageRequest
	Initialize bool `json:"initialize"`
	Adopt      bool `json:"adopt"`
}
type StorageSnapshot struct {
	VolumeID   string `json:"volumeId"`
	PoolID     string `json:"poolId"`
	Generation string `json:"generation,omitempty"`
	Exists     bool   `json:"exists"`
	Known      bool   `json:"known"`
	Ready      bool   `json:"ready"`
}

func (m *Manager) storagePool(request StorageRequest) error {
	i := request.Identity
	if i.Generation == "" {
		i.Generation = strings.Repeat("0", 64)
	}
	if err := i.validate(); err != nil {
		return err
	}
	pool, err := m.Pool()
	if err != nil {
		return err
	}
	if request.PoolID != pool.ID {
		return ErrConflict
	}
	return nil
}

func lockDirectory(ctx context.Context, file *os.File) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return nil
		}
		if err != syscall.EAGAIN && err != syscall.EWOULDBLOCK {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Publish immutable metadata without replacing a prior identity.
func publishStorageFile(parent *os.File, name, value string, uid int) error {
	path := fdpath(parent, name)
	if body, err := readSmall(path); err == nil {
		if string(body) != value {
			return ErrConflict
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.CreateTemp(fdpath(parent, ""), ".storage-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err = file.Chmod(0400); err == nil {
		err = file.Chown(uid, 1000)
	}
	if err == nil {
		_, err = file.WriteString(value)
	}
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	if err = os.Link(temporary, path); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		body, readErr := readSmall(path)
		if readErr != nil || string(body) != value {
			return ErrConflict
		}
	}
	return parent.Sync()
}

func storageGeneration(meta *os.File, id string) (string, error) {
	body, err := readSmall(fdpath(meta, "identity"))
	if err != nil {
		return "", err
	}
	parts := strings.Split(string(body), "\n")
	if len(parts) != 4 || parts[0] != "pi-cloud-volume-v1" || parts[1] != id || !generationPattern.MatchString(parts[2]) || parts[3] != "" {
		return "", ErrConflict
	}
	return parts[2], nil
}

func (m *Manager) InspectStorage(ctx context.Context, request StorageRequest) (StorageSnapshot, error) {
	result := StorageSnapshot{VolumeID: request.VolumeID, PoolID: request.PoolID}
	if err := m.storagePool(request); err != nil {
		return result, err
	}
	pool, err := directory(m.Root)
	if err != nil {
		return result, err
	}
	defer pool.Close()
	if err = lockDirectory(ctx, pool); err != nil {
		return result, err
	}
	known, err := m.lookup(request.VolumeID)
	if err != nil {
		return result, err
	}
	result.Known = known != nil
	root, err := directory(fdpath(m.root, "picloud-posix-"+request.VolumeID))
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer root.Close()
	result.Exists = true
	meta, err := directory(fdpath(root, ".pi-cloud-runtime"))
	if err != nil {
		return result, err
	}
	defer meta.Close()
	result.Generation, err = storageGeneration(meta, request.VolumeID)
	if err != nil {
		return result, err
	}
	result.Known = true
	if request.Generation != "" && request.Generation != result.Generation {
		return result, ErrConflict
	}
	if _, err = os.Lstat(fdpath(meta, "delete-authorized")); err == nil {
		return result, ErrClosing
	} else if !errors.Is(err, os.ErrNotExist) {
		return result, err
	}
	leaf, err := directory(fdpath(root, "workspace"))
	if err != nil {
		return result, err
	}
	defer leaf.Close()
	poolMarker, err := readSmall(fdpath(meta, VolumePoolFile))
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if string(poolMarker) != request.PoolID+"\n" {
		return result, ErrConflict
	}
	result.Ready = true
	return result, nil
}

func storageDirectory(parent *os.File, name string, create bool) (*os.File, error) {
	path := fdpath(parent, name)
	if create {
		if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, err
		}
	}
	file, err := directory(path)
	if err != nil {
		return nil, err
	}
	if create {
		if err = file.Chown(1000, 1000); err == nil {
			err = file.Chmod(0700)
		}
		if err != nil {
			file.Close()
			return nil, err
		}
	}
	return file, nil
}

func (m *Manager) PrepareStorage(ctx context.Context, request StoragePrepareRequest) (StorageSnapshot, error) {
	if err := request.Identity.validate(); err != nil {
		return StorageSnapshot{}, err
	}
	if err := m.storagePool(request.StorageRequest); err != nil {
		return StorageSnapshot{}, err
	}
	// Open a distinct descriptor: flock on the same description would not serialize goroutines.
	pool, err := directory(m.Root)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer pool.Close()
	if err = lockDirectory(ctx, pool); err != nil {
		return StorageSnapshot{}, err
	}
	if err = m.storagePool(request.StorageRequest); err != nil {
		return StorageSnapshot{}, err
	}
	poolIdentity := "pi-cloud-workspace-pool-v1\n" + request.PoolID + "\n"
	if request.Initialize || request.Adopt {
		err = publishStorageFile(pool, PoolIdentityFile, poolIdentity, 1000)
	} else {
		var body []byte
		body, err = readSmall(fdpath(pool, PoolIdentityFile))
		if errors.Is(err, os.ErrNotExist) {
			err = ErrMissing
		}
		if err == nil && string(body) != poolIdentity {
			err = ErrConflict
		}
	}
	if err != nil {
		return StorageSnapshot{}, err
	}
	known, err := m.lookup(request.VolumeID)
	if err != nil {
		return StorageSnapshot{}, err
	}
	if known != nil && (known.Generation != request.Generation || known.Released) {
		return StorageSnapshot{}, ErrConflict
	}
	root, err := storageDirectory(pool, "picloud-posix-"+request.VolumeID, request.Initialize && known == nil)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer root.Close()
	meta, err := storageDirectory(root, ".pi-cloud-runtime", request.Initialize && known == nil)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer meta.Close()
	lock, err := lockFile(ctx, fdpath(meta, "gateway.lock"), false)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer lock.Close()
	if err = lock.Chown(1000, 1000); err != nil {
		return StorageSnapshot{}, err
	}
	if _, err = os.Lstat(fdpath(meta, "delete-authorized")); err == nil {
		return StorageSnapshot{}, ErrClosing
	} else if !errors.Is(err, os.ErrNotExist) {
		return StorageSnapshot{}, err
	}
	generation, err := storageGeneration(meta, request.VolumeID)
	fresh := errors.Is(err, os.ErrNotExist)
	if fresh && (!request.Initialize || known != nil) {
		return StorageSnapshot{}, ErrMissing
	}
	if !fresh && (err != nil || generation != request.Generation) {
		return StorageSnapshot{}, ErrConflict
	}
	leaf, err := storageDirectory(root, "workspace", fresh)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer leaf.Close()
	if fresh {
		if err = empty(leaf); err != nil {
			return StorageSnapshot{}, err
		}
	}
	holds, err := storageDirectory(meta, "attachments", fresh)
	if err != nil {
		return StorageSnapshot{}, err
	}
	defer holds.Close()
	if fresh {
		if err = empty(holds); err != nil {
			return StorageSnapshot{}, err
		}
		if err = publishStorageFile(meta, "identity", "pi-cloud-volume-v1\n"+request.VolumeID+"\n"+request.Generation+"\n", 1000); err != nil {
			return StorageSnapshot{}, err
		}
	}
	if _, err = readSmall(fdpath(meta, VolumePoolFile)); errors.Is(err, os.ErrNotExist) && !fresh && !request.Adopt {
		return StorageSnapshot{}, ErrMissing
	}
	if err = publishStorageFile(meta, VolumePoolFile, request.PoolID+"\n", 1000); err != nil {
		return StorageSnapshot{}, err
	}
	if err = errors.Join(leaf.Sync(), holds.Sync(), meta.Sync(), root.Sync(), pool.Sync()); err != nil {
		return StorageSnapshot{}, err
	}
	return StorageSnapshot{VolumeID: request.VolumeID, PoolID: request.PoolID, Generation: request.Generation, Exists: true, Known: true, Ready: true}, nil
}

func (m *Manager) DestroyStorage(ctx context.Context, request StorageRequest) error {
	if err := request.Identity.validate(); err != nil {
		return err
	}
	if err := m.storagePool(request); err != nil {
		return err
	}
	root, err := directory(fdpath(m.root, "picloud-posix-"+request.VolumeID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer root.Close()
	meta, err := directory(fdpath(root, ".pi-cloud-runtime"))
	if err != nil {
		return err
	}
	defer meta.Close()
	lock, err := lockFile(ctx, fdpath(meta, "gateway.lock"), false)
	if err != nil {
		return err
	}
	defer lock.Close()
	generation, err := storageGeneration(meta, request.VolumeID)
	if err != nil {
		return err
	}
	if generation != request.Generation {
		return ErrConflict
	}
	pool, err := readSmall(fdpath(meta, VolumePoolFile))
	if err != nil {
		return err
	}
	if string(pool) != request.PoolID+"\n" {
		return ErrConflict
	}
	marker, err := readSmall(fdpath(meta, "delete-authorized"))
	if err != nil {
		return err
	}
	if string(marker) != "pi-cloud-volume-delete-v1\n"+request.VolumeID+"\n"+request.Generation+"\n" {
		return ErrConflict
	}
	holds, err := directory(fdpath(meta, "attachments"))
	if err != nil {
		return err
	}
	defer holds.Close()
	if err = empty(holds); err != nil {
		return ErrClosing
	}
	leaf, err := directory(fdpath(root, "workspace"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	leaf.Close()
	// Adopt coreutils' existing bounded-filesystem deletion, not a new tree walker.
	// Only this fixed infrastructure command receives a descriptor for the verified envelope.
	command := exec.CommandContext(ctx, "/bin/rm", "-rf", "--one-file-system", "--preserve-root=all", "--", "/proc/self/fd/3/workspace")
	command.ExtraFiles = []*os.File{root}
	if err = command.Run(); err != nil {
		return fmt.Errorf("Workspace deletion unconfirmed: %w", err)
	}
	if _, err = os.Lstat(fdpath(root, "workspace")); !errors.Is(err, os.ErrNotExist) {
		return ErrClosing
	}
	return root.Sync()
}
