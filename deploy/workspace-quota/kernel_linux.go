//go:build linux && cgo

// Copyright (c) 2026 PiCloud contributors.
// SPDX-License-Identifier: MIT
package quota

/*
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/quota.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/dqblk_xfs.h>
#include <xfs/xfs.h>

typedef struct {
  uint64_t total_bytes;
  uint64_t available_bytes;
  unsigned char uuid[16];
} pc_pool;
typedef struct {
  uint64_t hard_bytes;
  uint64_t used_bytes;
  uint64_t inodes;
  uint32_t id;
} pc_quota;

static int pc_pool_info(int fd, pc_pool *out) {
  struct statfs fs;
  if (fstatfs(fd, &fs) < 0) return errno;
  if (fs.f_type != XFS_SUPER_MAGIC) return EOPNOTSUPP;
  struct fs_quota_statv state;
  memset(&state, 0, sizeof(state));
  state.qs_version = FS_QSTATV_VERSION1;
  if (syscall(SYS_quotactl_fd, fd, QCMD(Q_XGETQSTATV, XQM_PRJQUOTA), 0, &state) < 0) return errno;
  if ((state.qs_flags & (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD)) != (FS_QUOTA_PDQ_ACCT | FS_QUOTA_PDQ_ENFD)) return EOPNOTSUPP;
  out->total_bytes = fs.f_blocks * fs.f_bsize;
  out->available_bytes = fs.f_bavail * fs.f_bsize;
  // statfs.f_fsid is derived from the device number; a loop remount changes it.
  // FSGEOMETRY returns the on-disk UUID and survives that device replacement.
  struct xfs_fsop_geom_v1 geometry;
  memset(&geometry, 0, sizeof(geometry));
  if (ioctl(fd, XFS_IOC_FSGEOMETRY_V1, &geometry) < 0) return errno;
  memcpy(out->uuid, geometry.uuid, sizeof(out->uuid));
  return 0;
}
static void *pc_pool_uuid(pc_pool *pool) { return pool->uuid; }
static int pc_get_quota(int fd, uint32_t id, int next, pc_quota *out) {
  fs_disk_quota_t data;
  memset(&data, 0, sizeof(data));
  data.d_version = FS_DQUOT_VERSION;
  data.d_flags = FS_PROJ_QUOTA;
  data.d_id = id;
  if (syscall(SYS_quotactl_fd, fd, QCMD(next ? Q_XGETNEXTQUOTA : Q_XGETQUOTA, XQM_PRJQUOTA), id, &data) < 0) return errno;
  out->hard_bytes = data.d_blk_hardlimit * 512;
  out->used_bytes = data.d_bcount * 512;
  out->inodes = data.d_icount;
  out->id = data.d_id;
  return 0;
}
static int pc_set_quota(int fd, uint32_t id, uint64_t bytes) {
  fs_disk_quota_t data;
  memset(&data, 0, sizeof(data));
  data.d_version = FS_DQUOT_VERSION;
  data.d_flags = FS_PROJ_QUOTA;
  data.d_id = id;
  data.d_fieldmask = FS_DQ_BSOFT | FS_DQ_BHARD;
  data.d_blk_softlimit = bytes / 512;
  data.d_blk_hardlimit = bytes / 512;
  if (syscall(SYS_quotactl_fd, fd, QCMD(Q_XSETQLIM, XQM_PRJQUOTA), id, &data) < 0) return errno;
  return 0;
}
static int pc_project(int fd, uint32_t *id, int set) {
  struct fsxattr attr;
  memset(&attr, 0, sizeof(attr));
  if (ioctl(fd, FS_IOC_FSGETXATTR, &attr) < 0) return errno;
  if (set) {
    if (attr.fsx_projid != 0 && attr.fsx_projid != *id) return EXDEV;
    attr.fsx_projid = *id;
    attr.fsx_xflags |= FS_XFLAG_PROJINHERIT;
    if (ioctl(fd, FS_IOC_FSSETXATTR, &attr) < 0) return errno;
  } else {
    *id = attr.fsx_projid;
    if (!(attr.fsx_xflags & FS_XFLAG_PROJINHERIT)) return ENODATA;
  }
  return 0;
}
*/
import "C"

import (
	"fmt"
	"os"
	"syscall"
)

type PoolInfo struct {
	ID             string `json:"id"`
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
}
type KernelQuota struct {
	ProjectID                        uint32
	CapacityBytes, UsedBytes, Inodes uint64
}
type Kernel interface {
	Pool(*os.File) (PoolInfo, error)
	Read(*os.File, uint32) (KernelQuota, error)
	Set(*os.File, uint32, uint64) error
	Project(*os.File) (uint32, error)
	Assign(*os.File, uint32) error
	MaximumProject(*os.File) (uint32, error)
}
type XFSKernel struct{}

func kernelError(code C.int) error {
	if code == 0 {
		return nil
	}
	return syscall.Errno(code)
}
func (XFSKernel) Pool(dir *os.File) (PoolInfo, error) {
	var value C.pc_pool
	if err := kernelError(C.pc_pool_info(C.int(dir.Fd()), &value)); err != nil {
		return PoolInfo{}, err
	}
	id := C.GoBytes(C.pc_pool_uuid(&value), 16)
	return PoolInfo{ID: fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:]), TotalBytes: uint64(value.total_bytes), AvailableBytes: uint64(value.available_bytes)}, nil
}
func (XFSKernel) Read(dir *os.File, id uint32) (KernelQuota, error) {
	var value C.pc_quota
	if err := kernelError(C.pc_get_quota(C.int(dir.Fd()), C.uint32_t(id), 0, &value)); err != nil {
		// XFS reports ENOENT for an unused or fully cleared dquot, including
		// immediately after Set(id, 0). Verify the mount still enforces project
		// quotas before interpreting that positive kernel result as zero usage.
		if err == syscall.ENOENT {
			if _, poolErr := (XFSKernel{}).Pool(dir); poolErr != nil {
				return KernelQuota{}, poolErr
			}
			return KernelQuota{ProjectID: id}, nil
		}
		return KernelQuota{}, err
	}
	return KernelQuota{ProjectID: uint32(value.id), CapacityBytes: uint64(value.hard_bytes), UsedBytes: uint64(value.used_bytes), Inodes: uint64(value.inodes)}, nil
}
func (XFSKernel) Set(dir *os.File, id uint32, bytes uint64) error {
	if id == 0 || bytes%512 != 0 {
		return syscall.EINVAL
	}
	return kernelError(C.pc_set_quota(C.int(dir.Fd()), C.uint32_t(id), C.uint64_t(bytes)))
}
func (XFSKernel) Project(dir *os.File) (uint32, error) {
	var id C.uint32_t
	err := kernelError(C.pc_project(C.int(dir.Fd()), &id, 0))
	return uint32(id), err
}
func (XFSKernel) Assign(dir *os.File, id uint32) error {
	if id == 0 {
		return syscall.EINVAL
	}
	value := C.uint32_t(id)
	return kernelError(C.pc_project(C.int(dir.Fd()), &value, 1))
}
func (XFSKernel) MaximumProject(dir *os.File) (uint32, error) {
	var maximum uint32
	for next := uint32(0); ; {
		var value C.pc_quota
		err := kernelError(C.pc_get_quota(C.int(dir.Fd()), C.uint32_t(next), 1, &value))
		if err == syscall.ENOENT || err == syscall.ESRCH {
			return maximum, nil
		}
		if err != nil {
			return 0, err
		}
		maximum = uint32(value.id)
		if maximum == ^uint32(0) {
			return maximum, nil
		}
		next = maximum + 1
	}
}
