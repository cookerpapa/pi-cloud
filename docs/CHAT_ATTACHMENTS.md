# Chat uploads and visual input

The composer accepts file selection, drag/drop and pasted images. Files selected
before a conversation exists remain in the browser until its Workspace is chosen.
Uploads to an existing conversation begin immediately; sending waits for the
selected files to finish. A failed upload can retry with the same identity.

Each file is placed at `<working-directory>/uploads/<upload-id>/<filename>`.
An existing, different file is never overwritten. Removing a draft card or
cancelling a queued message does not delete the Workspace file. Other code or
the user can subsequently edit it like any ordinary file.

Limits: four files per message, 16 MiB per file, 32 MiB total; nonempty files only.
Direct visual input supports PNG, JPEG and WebP. Images use the existing `high`
normalization policy inside Cube; combined normalized output is bounded at
32 MiB. Malformed images fail visibly before the first model call. Generic files
are described by filename, path, MIME type and size; the Agent decides which
Tools to use to read them. This feature does not promise arbitrary document
parsing or permanent archival of every uploaded file.

## Data flow and ownership

1. The authenticated API creates a bounded PG upload claim and forwards raw bytes
   through the Tool Broker. An elastic Workspace uses the existing Cube Volume
   Gateway; a dedicated machine uses a fixed guest helper under UID 1000. No
   Agent Run or shell command is fabricated to upload a file.
2. Image sources also receive an immutable copy in the existing private S3 image
   store. PG upload metadata pins the source. Draft claims expire after 24 hours;
   accepted attachments live with the native Session even if a queued input is
   cancelled or the mutable Workspace copy disappears.
3. Turn acceptance, queued edits and steer freeze bounded metadata/references
   with the input. No bytes enter PG command rows, Worker commands or Kafka.
4. The admitted Run uses its normal fenced Cube activation to decode/normalize
   sources before model use. Preparation is a bounded infrastructure operation,
   not an Agent Tool invocation. It holds no model permit and stays tracked until
   guest cancellation completes. Run closure also joins a late image-steer
   reservation before releasing its binding; normal release cancels and joins
   any remaining guest image preparation. A text-only input still needs no Cube
   activation.
5. The Harness gives Pi native text plus ImageContent. The existing Session codec
   externalizes the final image into the canonical append-only history and restores
   it on cold reads, Compaction and Fork. The Agent can see an attached screenshot
   in its first request without issuing `read` just to obtain its pixels.

The browser displays original user text separately from attachment cards. Its
previews use an authenticated API; no object-store credentials or public bucket
URLs are exposed. History, queue edits/reordering and promotion to steer retain
attachments. Ordinary files remain Workspace assets; only images get immutable
Session copies in this slice.

## Public API

All paths require the ordinary tenant authentication and mutation authorization.

| Request | Result |
| --- | --- |
| `PUT /v1/sessions/:sessionId/uploads/:uploadId?name=<encoded-filename>` | Binary `application/octet-stream` body; `200 UserUpload` after Workspace placement and image pinning |
| `DELETE /v1/sessions/:sessionId/uploads/:uploadId` | `204`; remove an unaccepted draft reference, leaving Workspace bytes intact; accepted references remain |
| `GET /v1/sessions/:sessionId/uploads/:uploadId/image` | Source image bytes, tenant scoped, private/no-store |
| `POST /v1/sessions/:sessionId/turns` | Existing request plus optional `uploadIds`; empty `prompt` requires an attachment |
| `POST /v1/sessions/:sessionId/turns/:turnId/steers` | Existing request plus optional `uploadIds`; empty `text` requires an attachment |
| Queued input `edit` action | Optional `uploadIds` replaces attachments atomically; omission preserves them |

Upload IDs are UUIDs chosen by the caller. Retry uses the same ID, filename,
source bytes, Session and Workspace. A conflicting reuse fails. A lost response
can be reconciled against the existing receipt; a partial upload never becomes
a ready input. The 120-second claim fences stale completions. File placement
uses confined directory descriptors, exclusive publication and checksum checks.
Each binary HTTP endpoint admits at most two upload bodies before buffering;
excess load returns 429. Each Session can hold at most 16 unaccepted ready/live
claims. Admission rejects unavailable, expired or differently scoped attachments.

`UserUpload` contains `id`, `sessionId`, `workspaceId`, `name`, `path`, `mimeType`,
`byteLength`, `sha256` and optional image reference. Conversation Turns and queued
inputs expose `uploads` when nonempty. The original prompt remains unchanged in
the public DTO; generated file descriptions belong to the native user input.

## Internal boundary and rollout

The API/Broker upload endpoint is `/internal/v1/workspace-upload`; the Volume
Gateway uses `/v1/workspaces/upload-file`. Both carry bounded JSON metadata in
`x-pi-cloud-upload` (base64url), raw HTTP file bodies and the existing scoped
service authentication. Broker validates a fresh PG claim; the Gateway repeats
the grant check while holding the Volume lock. Workspace deletion revokes new
file placement. Cube Volume initialization retains its existing late-create
generation limitation; this does not establish physical exactly-once effects.

Worker image preparation uses `tool_sandbox.prepare_input_images` with the
current assignment and source references. Its reply contains normalized image
references and dimension hints. One preparation executes at a time per Broker,
with at most eight waiting requests and a 30-second queue wait. The existing
Run/Cube authority, guest deadline and stop lifecycle apply. No result ledger,
new event consumer, storage service or Pi loop patch is introduced.

Deploy migration 154 and matched API, Worker, Broker, Volume Gateway, Web and Cube
guest builds. Preserve native history and existing image objects. The guest now
contains `envd-input-files.mjs`; an old template is not a supported fallback.
The decision and acceptance scope are in
[ADR-0200](adr/0200-workspace-uploads-and-user-image-input.md).
