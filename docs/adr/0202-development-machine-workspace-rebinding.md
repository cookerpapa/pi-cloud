# ADR 0202: rebind missing Workspaces to development machines

Status: implemented and validated, 2026-09-30.

[Acceptance](../reports/workspace-rebind-acceptance-20260930.md) covers PostgreSQL
release races, browser selection/retry and real Luna/Cube conversation continuity.

## Context

ADR-0118 separates conversation history from replaceable Workspace/compute.
The recovery dialog nevertheless lists only elastic Workspaces, and its backend
forces every binding to elastic `/workspace`. A ready user-owned development
machine therefore cannot be selected after the previous Workspace is deleted.

## Decision

- Keep rebinding limited to ordinary, unarchived conversations whose previous
  Workspace was deleted and whose execution has settled. History, native Session
  identity, model selection and previously accepted Run snapshots stay intact.
- Extend the existing `PUT /v1/conversations/:sessionId/workspace` body with
  optional `workingDirectory`, alongside `workspaceId`. The server derives the
  execution mode from the target Workspace's kind, never from a client claim.
  Elastic targets use `/workspace`; machine targets default to `/home/user` and
  can select another absolute directory through the existing directory picker.
- Bind machines only when the authenticated actor and conversation creator are
  the machine owner. Preserve existing user/tenant isolation; this is not Session
  ownership transfer. Only running or paused machines qualify, and an accepted
  unfinished release prevents binding. The browser can resume a selected paused
  machine using the existing resource API, outside the binding transaction.
- Lock the selected machine before its Workspace, matching lifecycle/Run admission.
  Recheck release intent in a fresh statement after the machine lock. Bind project,
  Workspace, machine identity, execution mode, profile and cwd in one PG transaction.
  Rebinding neither provisions a machine nor performs a Cube RPC while holding locks.
- Include cwd and actor identity in the idempotency fingerprint. A lost binding
  reply can replay the same operation; changing its target/cwd with the same key
  conflicts. The existing receipt table and response remain sufficient; no new
  storage authority or migration is introduced. Prior receipt hashes are not
  interpreted as requests under the expanded contract.
- Present existing elastic Workspace, new elastic Workspace and existing machine
  as three choices. Keep dialog selection separate from new-conversation state,
  refresh resource lists when opened, and reuse existing machine directory browsing.
  The user confirms the binding; showing the new option never changes it automatically.
- The next native World State reports `workspace_changed`, using wording independent
  of `/workspace` and without claiming an existing machine has empty files. No files
  or processes are copied from the deleted Workspace.

This uses existing PostgreSQL transactions, resource APIs, Cube mechanics and Pi
World State. It adds no infrastructure library or alternative execution runtime.

## Acceptance

Cover machine/profile/cwd binding, preserved conversation/model settings, following
Run routing, tenant/owner checks, missing/released/provisioning targets, active work,
release races and idempotent retry. Browser checks cover an empty elastic list with
a ready machine, directory selection and retry without recreating a Workspace.
Use an independently created test machine for live Luna/Cube acceptance; never
rebind or release the owner's existing machine or conversation during testing.

Deploy matched API, Worker (World State wording) and Web builds. Native history and
Guest execution protocol are unchanged. Existing elastic clients remain valid;
an old API cannot bind machine targets, so rollback requires the matched API/Web set.
