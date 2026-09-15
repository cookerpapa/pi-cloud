# ADR-0171: Subagent compute placement and explicit working directories

Status: accepted and implemented on 2026-09-15.

[Implementation and live acceptance](../reports/subagent-compute-20260915.md).

## Decision

Subagents keep the parent's Workspace/Volume. They no longer allocate or copy a
child Workspace. The model-facing tool takes `sandbox: shared | ephemeral`
(shared by default) and optional absolute `cwd` (the parent's directory by
default), independently of fresh/branch context and the file/shell allowlist.
Workflow `runs.run` and `runs.all` carry the same contract. There are no role profiles.

The parent uses ordinary guest Bash/Git to create worktrees when wanted, then
passes their path. PiCloud neither initializes Git nor commits/stashes/merges
on the user's behalf. Missing or out-of-volume directories fail explicitly;
they never cause mkdir, fallback to the parent directory, or a filesystem copy.
Worktrees and their shared Git directory have the same absolute paths in all VMs.

An ephemeral child owns a compute scope, not storage. Shared descendants inherit
the parent's compute scope; another ephemeral descendant creates its own scope.
The scope and working directory survive PG cold recovery and are frozen in Runs.
Broker permits multiple physical compute scopes against one Workspace Volume.
Ordinary user Sessions continue to share the Workspace's original warm runtime.
Exact bindings and operations remain scoped to their task ExecutionReference.

Tool activation remains lazy. Pure model/search tasks create no Cube. New child
Cubes mount the existing Volume at `/workspace` for elastic storage, or `/home/user`
for machine-owned home storage. A machine's system-disk directories (for example
`/etc`) are not shared volumes and cannot be selected for ephemeral child compute.
Sharing a parent machine directly still permits its ordinary directory semantics.

Child compute uses bounded elastic lifetime/idle recycling; retiring compute
never deletes the shared Volume or worktree. Active execution must remain alive,
and late cleanup cannot stop a sibling or parent scope. Native Cube expiry may
provide orphan reclamation, not Run cancellation or fencing. Lost compute retains
the existing UNKNOWN/reset semantics, not automatic shell replay or memory restore.

## Existing architecture

The one physical Pi Session / Worker family / owner lease and Lane model stays.
Commands still append Worker → Kafka → Projector → executor. All untrusted Git,
file and shell work remains in Cube; provider keys remain outside the guest.
This is cooperative file separation, not a security boundary between collaborators
sharing a writable Volume. It is never used to share Volumes across tenants.

## Adopted mechanisms

- Git supplies worktrees, local branches and merges; no new patch/merge service.
  https://git-scm.com/docs/git-worktree
- Cube's Volume API supports multi-attachment independently from sandbox lifetime.
  https://github.com/TencentCloud/CubeSandbox/blob/v0.7.1/docs/guide/volume-plugin.md
- The community Pi subagent workflow exposes explicit task/cwd placement; cloud
  scheduling, persistence and resource admission retain PiCloud's existing ports.
  https://github.com/nicobailon/pi-subagents/blob/main/docs/workflows.md

The retired independent-copy path includes the reproduced PG-lock-loss/target-
overwrite defect (LOCK-01). Remove that path instead of adding an unused copy
publication protocol. This does not claim all filesystem lifecycle faults solved.

## Cutover and acceptance

No old `workspace: isolated` execution adapter is retained. Drain old execution
and remove authorized legacy copy fixtures before applying the schema contract;
do not reinterpret an old isolated copy as a shared Volume. Keep normal user
identities, resources and conversation history outside the cleanup scope.

Validate direct/workflow/nested starts, explicit/default cwd, missing directory,
outside-volume and symlink escape, immutable Run restore, no eager activation,
same Volume/different VMs, shared descendants, sibling cancellation, warm expiry,
worktree local merge, and no child Workspace creation/deletion. Use real model,
Cube and Git acceptance with owned fixtures, then clean those fixtures.
