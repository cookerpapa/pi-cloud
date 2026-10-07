# ADR-0236: Recovery, returned input identity and native Tool diagnostics

Status: implemented and source-verified, 2026-10-07; matched deployment pending.
The [repair record](../reports/review-repair-20261007-r3.md) contains verification.
The owner approved the R07R3
repairs and document-read optimization, deferring R07R3-04 (CubeMaster logging).
This refines ADR-0229 without changing execution or storage authority.

## Decision

Quarantine recovery distinguishes execution admission from input acceptance.
A later Run with a start timestamp or lease supersedes earlier exit/seal proof;
an unstarted cancelled input does not. Keep the exact-lease exit check, projected
seal, active-Run exclusion and outstanding-seal exclusion. Retain withdrawn
input rows for return and admission idempotency. Timeouts never prove exit.

Each returned-input API item includes its required `idempotencyKey`, read from
the existing Run. The browser retires an uncertain submission only when both
its Session and key match an input successfully restored to that composer.
Restoration remains append-only to the draft, preserving edits and attachments.
An unrelated or newer submission keeps its key; Stop retries still use the
original immutable queue cut. No new receipt store or text-based deduplication.
The API and browser change together; there is no old-response fallback.

The fixed guest result carries Pi-compatible structured diagnostics separately
from content: severity, message and optional code. The Worker returns them through
Pi's public Tool API; the native Harness bounds data, renders diagnostics and
persists the canonical result. Read returns a UTF-8-safe prefix of an oversized
first line, matching pinned Pi Durable 1.0.0, plus byte continuation guidance.
Other ranged reads keep bounded source reading and put offset guidance in
diagnostics rather than appending it to file content. Unlike native full-file
Read, a bounded read does not scan the entire remaining file solely to report
total line/byte counts. Image handling and source limits remain unchanged.

Tool Worker protocol becomes **4**. Application, completion adapter and guest
artifacts must be built from the same source and deployed together; old protocol
3 messages are rejected. The Cube management protocol (7), guest input protocol
(4) and PG schema (182) do not change. No native Cube patch is required: its
completion payload is opaque to the native executor. Rollback likewise uses
matched artifacts after draining writers; no compatibility mode is retained.

A native document read uses the acknowledged overlay alone when it contains a
base at or before the requested point and the complete subsequent local suffix.
Otherwise it retains the existing PG revision/checkpoint merge. Flush still
waits for the projection watermark before discarding the overlay. This reuses
the single-writer prefix and native materialization code, adding no cache or
checkpoint authority. Measure local materialization cost as well as SQL count.

## Acceptance

- Real PG tests cover both proof orders, withdrawn/individually cancelled inputs,
  held Steer, retained uploads, missing proof and stale proof after later execution.
- Actual browser/API loss → Stop → return → resend admits a new Run with images;
  uncertain retries and newer post-Stop submissions keep their proper keys.
- Native/cloud text comparisons cover oversized ASCII/multibyte lines, offsets,
  limits, BOM/CRLF and image reads. The final Harness context retains diagnostics
  even when file text fills its output budget; the transport validates them.
- Official native Storage conformance covers hot/cold reads, versions, historical
  bases, checkpoints and eviction. Complete overlays issue zero revision SQL;
  missing bases still query PG. Record long-tail materialization cost.

These are bounded repairs within existing adapters. They adopt the installed,
MIT-licensed Pi 1.0 public result contract and existing PG/overlay fields, not a
new distributed protocol implementation, retry loop or scheduler.
