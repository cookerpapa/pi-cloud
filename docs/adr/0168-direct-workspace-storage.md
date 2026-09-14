# ADR-0168: direct Workspace storage, no per-Run object archive

Status: accepted and implemented.

Acceptance: [direct Workspace storage](../reports/direct-workspace-storage-20260914.md).

## Decision

Persistent Cube Volumes own elastic Workspace bytes; user-owned machines keep
their existing full-VM/home-Volume lifecycle. PostgreSQL registers resources,
bindings and execution authority, not another Workspace checkpoint head.

Remove per-Run Workspace capture/reference objects, random settlement revisions,
staged Workspace settlements, runtime object caches and the `runtime_objects`
table. Environment validation belongs to activation, not file settlement. A
missing old reference must not prevent reading a real directory or starting a
conversation. Session-native log projection, ordered seals and Lease/Fence remain.

Keep independent Workspace copying. A copy identifies its source physical Volume
generation and target identity; it does not invent a content revision. Existing
Tool/copy admission boundaries remain, without claiming an atomic snapshot of
user background writes. Resource generation protects deletion/recreation, not
ordinary file edits or concurrent user Sessions.

Do not archive oversized raw Tool output. Retain the bounded native Tool Result
and honest truncation guidance; no artifact IDs or full-output recovery promises.
Users can explicitly redirect command output to Workspace files. Future file
downloads may stream directly from the authorized Volume/machine; they do not
require PostgreSQL byte blobs or a new archival service.

## Cutover and verification

Deploy matching components without an old-wire compatibility mode. Drop obsolete
object/settlement data and columns, preserving identities, native conversations,
actual Volumes and machines. Verify empty/live browsing, multi-round coding,
warm/cold compute, isolated/shared child Workspaces, large output truncation and
cleanup. Measure request/settlement overhead separately from provider latency.

This supersedes the settlement half of ADR-0135; live filesystem browsing stays.
