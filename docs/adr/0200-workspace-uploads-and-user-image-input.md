# ADR-0200: Workspace uploads and native user image input

Status: implemented and accepted, 2026-09-29.

[Acceptance evidence](../reports/user-input-attachments-20260929.md).

## Context

The owner approved uploading files from the chat composer into its Workspace,
with server-generated file descriptions and direct visual input for attached
images. Session history and images are assets independent of the mutable
Workspace. The native Pi loop and the current writer/lease/dispatch boundaries
remain unchanged. Local/cloud execution handoff is not part of this change.

## Decision

- Add bounded, authenticated uploads owned by a tenant and conversation. File
  bytes travel over HTTP and land in a unique upload directory in the current
  Workspace. Cube Volume remains the sole mutable Workspace byte authority.
  Control Plane never mounts the Workspace or decodes untrusted image data.
  The existing provider/Volume Gateway boundary owns file placement, including
  initialized Volume identity, path confinement and complete-file publication.
- Use a stable upload ID, source checksum and scoped metadata to reconcile lost
  replies. A retry cannot silently overwrite a different file. Upload metadata
  records file identity, scope, state and attachment references, never file bytes,
  Tool results or an alternate Workspace checkpoint.
- Preserve an immutable source image in the existing private attachment store
  when an image is uploaded. Pending drafts expire; accepted input retains its
  image independently of Workspace deletion and projection delay. This extends
  ADR-0192's reachability to durable user inputs before their native consumption.
  Abandoning a draft releases its attachment claim; it does not erase a file
  which the user has already placed in the Workspace.
- Only bounded references enter accepted input, queue rows and Worker commands.
  Text and attachment identity freeze together at execution admission. Duplicate
  input, queued edits/cancellation/reordering and promotion to steer preserve
  these identities. A changed Workspace cannot silently reinterpret a previously
  uploaded path as a file in the new environment.
- Before model use, images are decoded and normalized inside the current Run's
  Cube through a fixed infrastructure preparation operation. It uses existing
  Run authorization, Broker fencing and Cube capacity/lifecycle controls. It is
  pure input preparation, not a fabricated model Tool call, and holds no model
  permit. The immutable source is read from attachment storage, not from a
  possibly changed Workspace file. Normalization failure is explicit.
- The Harness assembles one ordinary Pi user message: original text, escaped
  file descriptions (name, actual tool-visible path, MIME type and size), and
  native ImageContent for supported images. The existing Session codec stores
  only image references in Kafka/PG and restores native images for replay and
  Compaction. No Pi loop patch or new message broker is introduced.
- The UI keeps user text and attachment cards separate. It supports file picking,
  image paste/drop, progress/failure/removal before send, image-only messages and
  persisted attachments in history. Unsupported visual input is rejected rather
  than silently claiming a model has seen the image. Ordinary files are provided
  by path; they are not automatically expanded into model context or archived as
  permanent generic file attachments.

## Adopt before build

Pi 0.84.1 already supports TextContent + ImageContent in prompt, steer and
follow-up. Its CLI file processor adds a file-path label beside an image part.
The inspected Codex source (40e5de9) similarly supplies image labels/paths and
InputImage; its [public input protocol](https://learn.chatgpt.com/docs/app-server#items)
separates text/image/localImage. [OpenCode's attachment API](https://opencode.ai/v2/docs/attachments)
also separates attachment metadata from model-visible content.

Reuse pinned Fastify/HTTP transport, Cube's volume and guest execution APIs,
the existing pinned Sharp image processor inside Cube, and the AWS S3 SDK
attachment port. [Fastify content parsing](https://fastify.dev/docs/latest/Reference/ContentTypeParser/)
supports bounded binary bodies; [Node file APIs](https://nodejs.org/api/fs.html)
provide exclusive creation, rename and fsync. A resumable upload service such as
[tus](https://tus.io/protocols/resumable-upload) adds persistent upload offsets and
another staging lifecycle without a measured need for this bounded first slice.
Do not build a chunk broker, generic file archive or new sandbox scheduler.

## Acceptance and rollout

Cover tenant/session/Workspace identity, unsafe paths and symlink races, size and
concurrency limits, duplicate and lost upload replies, partial writes/cancellation,
source-file changes, image preparation failure and safe retention/cleanup. Cover
image-only input, pending input edits/promotion, native user images, cold restore,
Compaction, Fork and actual model vision without an Agent read Tool call.

Document public/internal contracts and use a matched schema/application/guest
rollout. Preserve existing history. Validate browser interaction and real GPT-6
Luna/Cube behavior using disposable resources; record limits rather than implying
arbitrary file-format understanding or generic exactly-once external effects.
