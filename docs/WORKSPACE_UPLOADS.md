# Workspace files, continuation and local drafts

[ADR-0295](adr/0295-workspace-file-transfers.md),
[Issue #3](https://github.com/cookerpapa/pi-managed-agents/issues/3).
BACKLOG records implementation and publication separately.

## Interaction and retention

Dragging a file into the composer creates a local card. Choose **Keep with
conversation** (default) or **Workspace only** before Send. Long text paste remains
an automatic retained attachment. Selection does not start transfer. Send freezes
source, retention and destination, uploads the file, then admits the message
through existing PG/native input semantics. A partial upload is neither a sent
message nor a queued steer/follow-up. Changing an already-started file's retention
requires a new draft.

Workspace-only files have no S3 original or conversation-attachment reference.
Composer placement uses `<cwd>/uploads/<UUID>/<name>`. The file panel instead
allows a selected existing directory, independent upload and path insertion.
Referencing an existing file does not copy it. Existing different files are never
silently overwritten. Retained attachments keep the original and mutable working
copy described in ADR-0294; retention is not a backup of later Workspace edits.

Ordinary model input describes filename, size and Workspace path, not buckets,
object keys, storage URLs or duplicate storage. Direct visual attachments retain
their image-content behavior. An image explicitly selected as Workspace-only is
a file reference, not automatic visual input.

## Browser close and recovery

The browser saves draft text, file descriptors, retention/target and upload/request
identities, scoped by account and Session. Ordinary local file bodies are not
cached. Browser-created/edited text drafts retain text where local storage permits,
because they have no disk source to reselect. Storage failure is visible; sending
can still proceed, but local recovery is then unavailable. This is not cross-device
draft synchronization.

Closing interrupts transport, not cancels it. The same browser restores the draft
in the composer and asks the receiver for progress. An incomplete disk source
requires reselection and a matching digest; filename/size alone is insufficient.
Reopening does not automatically upload or send. File mutation/deletion or lost
browser data can require a new selection.

A lost input acknowledgement uses the saved submission identity. A read-only
confirmed receipt retires that old draft, preserving newer edits. A missing
projection is **unconfirmed**, not rejected; explicit retry uses the frozen
payload/key. Stop-returned inputs retire their previous submission identity and
become a new editable intent.

Paused staging expires after 24 hours without valid transfer activity. The existing
receiver maintenance owns physical cleanup. Cancellation revokes admission and
cleans only unfinished bytes. A published file survives cancellation even when its
completion response was lost. Dedicated-Guest transit sources abandoned before
preparation expire in the fixed `/tmp/pi-cloud-upload-<UUID>` namespace; ordinary
command envelopes, background processes and Workspace files are excluded.

## Authorities and transport

PG `workspace_file_transfers` stores bounded actor, frozen Session/Workspace/cwd,
target, length/digest, claim, state and expiry/cleanup metadata. It is neither a
permanent file inventory nor a Run queue and contains no file body or byte offset.
Revoked cleanup targets back off so one unavailable machine cannot block all rows.

The receiver filesystem owns byte position and publication receipt. Pinned
`@tus/server` supplies HTTP continuation behind a PiCloud remote DataStore adapter;
the browser uses `tus-js-client`. There is no new daemon, broker or cache. The
8 MiB PATCH bound controls transit chunks, not total file size. The retained
original PUT still retries a whole stream; S3 multipart is a separate slice.

```text
Browser -> API -> SandboxWorkspaceFiles
                  -> Volume Gateway (elastic, VM-free)
                  -> fixed Guest helper (dedicated)
                  -> persistent staging -> verification -> publication
```

Existing owner/receiver admission, Volume locks and per-transfer OS locks serialize
append against the actual offset. Length/SHA-256 verification and exclusive
publication precede ready acknowledgement. Interrupted publication that cannot be
reconciled reports uncertainty; it never guesses that a user file should be
recreated. Completed receipts do not overwrite subsequent modifications. Binding
changes cannot retarget old requests; status/retry cannot create a missing Volume.

## Public API

Existing tenant authentication and mutation authorization apply. Creation is
PiCloud-owned; byte continuation uses tus 1.0 HEAD/PATCH.

| Request | Behavior |
| --- | --- |
| `POST /v1/sessions/:sessionId/workspace-files/:uploadId` | `{workspaceId, workingDirectory, name, byteLength, sha256, directory?}`. Omit directory for composer placement; empty string selects cwd. Same UUID requires the same identity. |
| `HEAD .../workspace-files/:uploadId/content` | Receiver-confirmed offset and length. |
| `PATCH .../workspace-files/:uploadId/content` | `Upload-Offset`, known Content-Length and `application/offset+octet-stream`; at most one transport chunk. |
| `GET .../workspace-files/:uploadId` | Metadata/state/offset, not file bytes. |
| `DELETE .../workspace-files/:uploadId` | Cancel unfinished staging; an already-published file remains ready. |
| `GET /v1/sessions/:sessionId/input-receipt?key=...` | `{status:"accepted"|"unconfirmed"}` from existing PG/native receipts, with no new input or receipt authority. |

The resource includes `id`, `sessionId`, `workspaceId`, `name`, absolute `path`,
`byteLength`, `sha256`, `state`, `offset` and `expiresAt`. The private
`/internal/v1/workspace-file-transfer` uses protocol-v1 bounded metadata and raw
chunk streams under existing service authentication/owner routing. A consumed
stream is not blindly redirected or replayed by an internal proxy.

## Historical files and validation

Opening, resuming or searching a conversation does not restore its old working
files. Historical paths are facts, not promises of current availability. Original
A cannot reconstruct a later working copy B. The proposed history/download Tool
contract is a separate slice: only explicit Agent download or user reuse would
place an original into a current Workspace. This feature adds no such Tool.

Run the receiver/Guest/HTTP/PG contracts and browser gates before matched release.
The live driver exercises owned 5 GiB elastic and 1 GiB dedicated browser transfers,
pause/reload/reselection and canonical Luna Bash digest verification. It samples
driver RSS, summed Chrome-process RSS, JS heap and Control Plane RSS; these are
sampled values, not peak-PSS or fleet guarantees. Source checks are not live evidence.

```sh
PI_CLOUD_BROWSER_SCOPE=workspace-transfers npm run browser:presentation:check
PI_CLOUD_LIVE_WORKSPACE_TRANSFER_CHECK=1 node --import tsx scripts/run-live-workspace-transfer-check.mjs /private/transfers.json
```

Optional live scope: `elastic` or `machine`; default `all`. Confirmed physical
deletion of owned compute/Volumes precedes fixture metadata removal.
