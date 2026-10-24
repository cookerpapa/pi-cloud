# ADR-0274: Explicit image generation through the ordinary Tool catalog

Status: implemented and deployed in `image-tool-0bac4e97`; see
[delivery evidence](../reports/image-tool-delivery-20261025.md).
Date: 2026-10-24.

## Decision

The owner approved an ordinary `generate_image` Tool with Codex's public parameter
shape: `prompt`, optional `referenced_image_paths`, optional
`num_last_images_to_include` (1–5), and optional `transparent_background`.
Reference paths and recent-image selection are mutually exclusive. There is no
model, credential, provider URL or destination parameter. The current Conversation
owns reference selection; the immutable native assistant entry that issued the
call bounds recent-image lookup. Follow-up drafts, newer entries and unrelated
child Conversations cannot change those references.

The execution-side registry owns the definition and implementation. The existing
management WebSocket distributes the complete catalog; Pi's public Registry
applies it at the next model request. Worker callbacks and native settlement stay
generic. No Skill loader, new queue, service, operation ledger or Pi loop patch
is introduced.

The trusted implementation calls the configured CLIProxyAPI Images endpoint.
Provider credentials remain in CLIProxyAPI. Its pinned image adapter can use the
existing Codex subscription; access is validated before feature publication and
never silently falls back to a separately billed API key. Normal chat requests
must no longer acquire undeclared image-generation tools from proxy injection.
PiCloud makes one Images request; uncertain completion is not retried.
The pinned gateway's zero `request-retry` setting does not disable its inner
account/model failover loop. A small, pinned Images-only interceptor guard blocks
another account/model admission for the same non-streaming request, preserving the
existing interceptor and ordinary chat policy. Its patch must apply cleanly and
its upstream-package test passes during image build. This is an explicit
maintained overlay, not a claim about upstream's default failure semantics.
The upstream's known-401 credential refresh remains distinct from replay after
an uncertain generation outcome.
Fresh initialization and matched upgrades reconcile the same runtime policy;
upgrades do so only after draining writers and before replacing the provider Pod.

## Effect admission and recovery

Repeatable control effects retain their existing reconciliation. Add an execution
policy for non-replayable ordinary effects: confirm the existing Kafka dispatch
commit before admitting them, start them only on that original delivery, and
return UNKNOWN when recovery finds their unfinished intent. A rewind cannot
resubmit them. Keep a pending completed reply while delivery retries; failures in
reply validation, attachment encoding or delivery must not run the effect again.
Cancellation, partition loss and closure abort local I/O and remove admission.
An aborted HTTP request is not proof that the upstream generation stopped.
Late results cannot overwrite native Pi abort settlement. There is no exactly-once
claim about the remote provider.

## Image and Workspace ownership

Reuse the S3 image codec and existing boot-scoped Tool reply transport. Kafka and
PG contain references, never image bytes. Image parsing/normalization and file
access run in Cube through a fixed, bound image-I/O operation. The control plane
does not mount a Workspace or run user code. Generated files are placed under
the current tool directory's `generated_images/`, with operation-derived unique
names and exclusive publication. The canonical PNG preserves image pixels and
alpha within the existing decode limits. The same resulting image is returned to
Pi, retained by native history, and displayed by the existing image presentation.
Workspace placement failure is reported separately from successful generation;
it never authorizes another upstream generation.

## Adopt-before-build evidence

The pinned CLIProxyAPI commit
`48549e65b86d17648029190331807b89e7fd65f4` already implements Images generation
and editing routes, including subscription-backed Codex adapters. Codex's local
public source `40e5de94e9` defines the prompt/path/recent-image parameters; the
currently exposed tool also provides transparent background. OpenAI documents
both standalone Images requests and Responses-hosted generation:
<https://developers.openai.com/api/docs/guides/image-generation>.
Reuse these adapters, Pi Registry/unsafe Tool semantics, Kafka dispatch commits,
the existing S3 port and guest image processor instead of a generation scheduler
or a second durable result store.

## Acceptance and publication

- Text generation, path references, bounded recent-context references and alpha.
- Invalid/mutually exclusive arguments, missing references, provider refusal,
  uncertain response, cancellation, partition handoff and reply/attachment loss.
- Same running native submission learns a previously unknown Tool through its
  catalog; accepted invocations keep their original contract after withdrawal.
- Images survive cold history reads without resubmitting generation.
- Matched publication retains accounts, configuration, history and Workspace
  files, with ordinary writer drain and confirmed compute retirement.
- After isolated checks, send exactly the owner-requested message in the existing
  galgame conversation: “按照我给你的图片，生成相似风格的人物设计”. Confirm the actual
  reference, generated file, canonical Tool result and live/cold display.
