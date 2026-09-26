# Session image attachments and GPT-6 — 2026-09-26

The approved image transport is implemented and deployed locally. Real GPT-6
Luna consumed large Tool images and recovered their content on another Worker
after the source path had been overwritten. The model was not given the image
digits as text; the expected values were read through the independent Workspace
file API after the model answered.

Implementation: `487d09c9`; Cube HTTP bound correction: `089fa573`.
The maintained decisions are [ADR-0191](../adr/0191-gpt6-model-catalog.md) and
[ADR-0192](../adr/0192-session-image-attachments.md).

## Result and boundaries

Cube executes Pi's fixed read Tool with its public image processor hook. The
trusted Broker uploads normalized image bytes to private S3 and sends references
through the existing boot-scoped Kafka reply channel. Worker verifies/fetches the
image before returning ordinary ImageContent to Pi. The native Session append
adapter externalizes the final after-hook content; cold reads reconstruct it.
No Agent Loop patch, result GET/cache, Tool replay or Workspace checkpoint was added.

PG owns image inventory and retained-log references; S3 owns immutable bytes.
The source Cube Volume continues to own editable Workspace files. Opaque Tool
details, arguments and custom data retain their original JSON meaning.

The bundled backend is SeaweedFS 4.47 with SQLite FULL metadata and bucket fsync.
Its OCI digest is
`sha256:1ed51b50d7586b42761b507b6ee3fc7f4b305ce2fca7590c438bb71c9c0813c9`.
AWS S3 SDK 3.1141.0 and guest-only Sharp 0.35.4 are pinned. Private storage
credentials never enter Cube or the browser.

## Live evidence

[Detailed image acceptance](image-attachments-live-20260926.json):

| Read | Detail | Immutable image bytes | PG native record bytes |
| --- | --- | ---: | ---: |
| First 1600×1600 image | high | 6,597,579 | 778 |
| Replacement 1600×1600 image | high | 6,597,004 | 778 |
| Replacement 3200×3200 image | original | 26,343,518 | 779 |

All three Runs executed actual Bash and read Tools in Cube. The same `shot.png`
path was overwritten twice; the earlier attachment still passed its original
SHA-256 check. After stopping the last owner, the other Compose Worker completed
a Tool-free Run that correctly identified the digits in all three historical
images. The original Worker was restored.

These byte figures describe the native PG records, not measured complete Kafka
record sizes. Producer validation forbids inline native image parts; references
remain subject to the existing small-record budget.

[Storage crash evidence](image-storage-crash-20260926.json) separately confirms
byte-identical retrieval after killing the S3 process immediately after a 5 MiB
PUT acknowledgement. This tests process failure, not power failure or physical
multi-node HA.

Test conversations were archived and their disposable Workspaces released using
the product API. Under existing ADR-0114, deleting a conversation archives its
history; it does not physically purge the native log. The six references from
the final acceptance and prior protocol-successful rehearsal therefore remain
legitimately retained. Unreferenced uploads follow the 24-hour cleanup grace.
The separately generated `acceptance/` S3 probe objects were removed.

## Models

The visible catalog is GPT-6 Astra, Sol, Luna and DeepSeek V4 Pro. New Web
conversations select Sol; paid GPT probes use Luna. Astra is an optional higher
cost tier and excludes disabled reasoning. Migration 150 updates future profiles
without changing accepted Turn, Run or native model history. The deployed database
retains ten historical GPT-5.6 Turns.

[Actual Luna capability checks](gpt6-capabilities-20260926.json) passed a function
call, a 3.2 MiB image returned as a function result and provider-hosted web search.
Current [OpenAI pricing](https://developers.openai.com/api/docs/pricing) lists
standard short-context Sol input/output at $2/$10 per million tokens and Luna at
$0.10/$0.50. These API rates are not a measurement of subscription billing.

[DeepSeek probes](deepseek-search-20260926.json) found two public model IDs.
`deepseek-flash` ignored Responses web search, while the same model on Anthropic
Messages returned two real search-result blocks. A separate public search model
was not verified. Flash remains hidden on PiCloud's existing Responses route;
no auxiliary search request or protocol substitution was introduced.

## Verification and rollout

- [Final verification](image-attachments-verification-20260926.json): `npm run check`
  completed with all workspace typechecks passing, 1,134 tests passed, 116 opt-in
  integration tests skipped and zero failures. Real PostgreSQL checks below were
  executed separately, rather than counting those skips as coverage.
- [Fault gate](image-attachments-faults-20260926.md): 48/48 mandatory cases passed,
  including real PostgreSQL retention/cleanup races and individual oversized
  Kafka record isolation.
- Real PostgreSQL image tests cover cold storage, Fork retention, corrupt/missing
  bytes, tenant denial, upload failure, unprojected Run protection, deletion
  interruption and opaque JSON. Separate migration checks preserve issued history.
- Guest tests cover Codex dimension/patch examples, 16-bit normalization, large
  inputs, malformed images and images without filename extensions. HTTP transport
  checks cover the 64 MiB bound and fragmented image replies.
- Formatting, documentation, runtime-budget policy, image closure, Helm rendering,
  installer contract, application build and the high/critical security gate passed.
  The security audit still reports two moderate development-only Vitest findings.

[Rollout inventory](image-attachments-rollout-20260926.json) records one host,
two Compose Workers, RF3 Kafka, PostgreSQL, Cube KVM and private S3. A private
696,632-byte pre-migration PG backup was taken. With zero unfinished Runs,
leases and unsealed Sessions, old executors were stopped, migrations 150/151
applied and matching services restarted. Schema is 151 and all long-running
application services are healthy.

Guest build identity is `73ef2cd48c0aea33616bad926553d921f9492418`; its OCI digest is
`sha256:7578a279e1dc234f755aeac6a05480ada83cbbde8d59a180f5c4fe497a5ad576`.
All four Cube template profiles reached READY. Eleven pre-existing obsolete
templates still could not be pruned because of stale-node cleanup timeouts;
the existing backlog item remains open.

The first live image attempt exposed an additional 32 MiB *configuration* ceiling
in Cube's HTTP client, below the new 64 MiB response allowance. The shared limit
and an actual HTTP-client contract test now cover that boundary. A later rehearsal
completed image transport and owner replacement, but its verification incorrectly
depended on another model Tool call; the final test uses an independent file read.
Neither failed attempt is counted as successful live acceptance.

Limits are explicit: input 64 MiB/100 million decoded pixels, normalized image
42 MiB, high 2048/2500 patches and original 6000/10000 patches. Model request bodies
are capped at 128 MiB. Native context reduction remains Pi-owned; image storage
does not remove provider request/context costs or prove unlimited screenshot scale.
