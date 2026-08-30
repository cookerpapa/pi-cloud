# 0135 — Live Workspace browser and lightweight settlement

## Status

Accepted.

## Context

The persistent Cube Volume is the sole authority for Workspace bytes. An older
product direction generated one complete path/size/SHA-256 File Index after
every Tool-using Run, embedded that index in an object named
`workspace_snapshot`, and made the Web file browser read through an immutable
`WorkspaceVersion` API.

PiCloud no longer offers historical Workspace file browsing, platform Diff,
Patch or rollback. Scanning every file at Run settlement therefore adds I/O
proportional to the entire Workspace while serving a current-files-only UI.
The names `snapshot`, `checkpoint` and `materialize` also imply that PostgreSQL
owns a recoverable byte copy, which is false.

## Decision

Run settlement records only a small, immutable Volume reference containing the
Volume identity, a newly issued settlement revision, execution binding and
environment evidence. It contains no file list, file hash or Workspace bytes.
The persistent Volume remains the only file authority.

The Workspace browser is Session-scoped and live:

```text
open Workspace      -> list the selected root directory
expand directory    -> list only that directory
open file           -> read only that current bounded file
```

Control Plane derives the Session's Workspace and working-directory root.
Browser input can select only a relative path below that root. Tool Broker and
Workspace Volume Gateway rejects traversal and symlink escape. `.git` and
`.git-credentials` are omitted from directory results; other project dotfiles are
ordinary visible files. Listing and reading persistent bytes do not create a
Cube.

The maintained vocabulary is:

- **Workspace settlement** — a fenced Run boundary and lightweight Volume
  reference;
- **settlement revision** — an opaque observation identity, not a content hash;
- **live Workspace browser** — current directory listing and file read;
- **runtime object** — bounded immutable settlement or Tool-output bytes kept
  beside PostgreSQL metadata.

Historical migrations retain their original names, but the current schema,
protocol, services, metrics and documentation use this vocabulary.

## Consequences

- Run settlement cost no longer scales with Workspace file count or byte size.
- The Web UI intentionally displays current files, not a historical snapshot.
- A file may change between two browser requests; refresh returns current
  state instead of claiming immutability.
- Workspace recovery still reattaches the persistent Volume. Settlement records
  cannot restore files and are not a backup mechanism.
- Storage-native snapshots remain a future opt-in feature for rollback or
  disaster recovery; they are not recreated in the default Run path.
