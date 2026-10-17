# Worker → Pi Tool settlement review

Date: 2026-10-18 (Asia/Shanghai). Reviewed baseline:
`7a9f92429a0b311263c35d1a0f74930c4c3fc385`. Serving release remains
`worker-reply-b1f67dba`; its implementation source is unchanged.

Scope: the prepared remote Tool's return into Pi Durable 1.0.0, native
`afterTool`/output processing, the atomic result/task/live-state commit, and the
Worker's committed-event observer. Publication transport after this Storage
boundary is the next walkthrough hop. This review changes only review artifacts
and documentation, with no production execution, protocol or deployment change.

## Findings

### WHS-01 — P2: the native default silently changes the accepted control-Tool result budget

ADR-0196 admits Subagent/control results up to 256 KiB after JSON encoding and
requires accepted string/JSON representations to remain complete. An excessive
result must become a bounded error, not a successful truncated JSON value.
The current Tool description still advertises that contract.

`WorkerToolRuntime.create()` registers the control definitions without explicit
native `outputLimits`. `DurableRemoteTools` preserves that omission. Pi's
`ToolTask.finalResult()` consequently applies its default 50 KiB/2,000-line
limits after the cloud serializer has accepted the result. This happens before
the canonical Entry is stored and used as model context, not just in the web UI.

The actual native Harness and cloud definitions reproduce both cases:

- An accepted 81,994-byte Subagent JSON result becomes a 51,200-byte first text
  part. Its closing structure and final marker disappear; JSON parsing fails,
  while the Tool result still has `isError=false`. Pi adds a truncation diagnostic,
  but the accepted result's representation has already changed.
- A 20,904-byte supervisor reply with 2,201 lines loses its final decision at the
  native 2,000-line boundary. The full reply remains in `details`, so retaining
  the metadata does not restore the missing model-facing text.

Locations: `packages/supervisor-host/src/tools/worker-tool-runtime.ts:130`,
`packages/protocol/src/control-tools.ts:143`,
`packages/protocol/src/tool-result-budget.ts:20`,
`packages/control-plane/src/control-tool-results.ts:6` and pinned
`node_modules/@earendil-works/pi-durable/dist/harness/tool.js:130`, `:289`.

Repair direction: keep ADR-0196's single admission policy and configure the
trusted control Tools through Pi's public `ToolRegistration.outputLimits` so
accepted results are not cut again by unrelated defaults. Coordinate both bytes
and lines. Preserve fixed Read/Bash limits, native final settlement, explicit
oversize errors and the UI's independent display truncation. Do not patch Pi,
raise Kafka limits or introduce an implicit large-result store. Add native
Harness contracts for valid long JSON, multiline replies and oversize errors.

### WHS-02 — P2: the committed observer reads full results even when it has nothing to publish

The native Tool completion produces `tool_execution_end` and `message_end`
events containing the same Tool Entry. `DurableRunEvents.consume()` emits no
PiCloud body for either event: Tool presentation already travels in the native
commit under ADR-0249. Nevertheless, `PiCloudTurnRunner` calls
`owner.storage.entry(entry.id)` for each event to obtain `commitSeq`, before
checking whether there are any bodies to send.

Warm overlay reads need no PG request. After eviction, this lookup joins the
stored body and decodes its image attachments. Large decoded records exceed the
128 KiB read-cache admission threshold, so the second lookup fetches the same
body and image again. The existing `recordSequence()` helper also calls `#get()`;
merely switching the caller to that helper does not remove this coupling.

Isolated evidence:

- The actual native Harness produces both events, and the actual event adapter
  produces zero display bodies for them.
- With a real disposable PG database, a 196,608-byte image and an explicitly
  flushed overlay, the two `entry()` lookups cause two projection-body queries
  and two image-store reads, transferring 393,216 bytes through the fixture blob
  port. Calling `recordSequence()` twice produces the same result.
- Making that blob port unavailable makes `recordSequence()` fail, although a
  direct metadata-only query still returns the existing sequence.

This is not a claim that every Tool adds two SQL round trips: eviction and image
size determine the cold path. The fixture counts body/blob accesses, not physical
S3 network bandwidth or production latency. The observer currently stores read
errors as `deliveryFailure`; the isolated failure proves avoidable metadata/body
availability coupling, not a newly injected production Run failure.

Locations: `packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts:712`,
`packages/sandbox-supervisor/src/durable/run-events.ts:60`,
`packages/pi-session-postgres/src/durable/published-storage.ts:124`, `:234`, and
`packages/pi-session-postgres/src/durable/postgres-projection.ts:146`.

Repair direction: omit sequence lookup when the observer has no outgoing body,
while retaining its observed-entry advancement. Give `recordSequence()` an
actual metadata-only cold path behind the existing Storage/projection port.
Keep acknowledged in-memory sequence lookup and the current ownership/serialization
guards; no second sequence authority, result cache or PG receipt table is needed.
Verify that image-store unavailability cannot break a metadata-only read.

### WHS-03 — P3: final-reply content validation is weaker than the settlement contract

`ToolResultDataSchema.content` is an array of unrestricted values. The comment
delegates image representation checks to the attachment codec, but that codec
only decodes recognized image references; it does not validate ordinary text
parts or unknown part kinds. The mailbox can therefore set `executionSettled`
after a payload which is still invalid as a Tool result.

Injected matching replies containing `null`, `{type:"text",text:17}`, or an
unknown part kind pass `parseWorkerReply`, mailbox validation and image restoration.
They are marked as known settlement. The later same-commit presentation parser
rejects those parts. In the numeric-text case, Pi's native text bounding also
does not supply the missing transport schema guarantee: TypeScript declarations
are not runtime validation.

This is a reproduced malformed-frame contract gap, not evidence that a normal
maintained Tool currently emits these payloads, nor a claim that invalid data has
reached production canonical history. Some malformed guest values can fail even
earlier in Cube's completion adapter. It is lower priority than WHS-01/02.

Locations: `packages/protocol/src/tool-result.ts:36`,
`packages/event-log/src/tool-replies.ts:228`,
`packages/session-attachments/src/configured.ts:84`,
`packages/supervisor-host/src/tool-reply-result.ts:20` and
`packages/sandbox-supervisor/src/durable/tool-presentation.ts:130`.

Repair direction: validate PiCloud-owned text and image-reference structures at
the existing final-reply boundary before claiming a valid final receipt. Keep
guest-native image and packed Kafka representations explicit. Invalid frames
should use the existing protocol-failure handling before entering Pi; do not
add per-Tool lease queries, signatures or another execution authority. Preserve
empty content and permitted image metadata, with positive/negative contracts.

## Sound boundaries and accepted tradeoffs

- The Worker returns a `ToolExecutionResult` from a registered public Tool.
  Pi still performs `afterTool`, final output processing and canonical append.
  Cloud code does not implement another Tool task state machine.
- Result Entry, native Tool terminal state and live-slot completion occur in one
  Storage batch. Holding that batch's acknowledgement prevents the next model
  request; the cloud callback's receipt does not become the canonical commit.
- Reopening the committed prefix before that batch produces native interrupted
  Tool handling without executing the command again. Reopening the prefix with
  the result batch preserves the result without replay. The probes compare
  committed-prefix snapshots, not a real Kafka ACK-loss or production crash.
- Existing Stop/late-result, attachment-failure, receipt-deadline and ownership
  priority tests continue to pass. Result receipt followed by image restoration
  remains separate from native settlement under ADR-0254.
- The accepted receipt-before-commit crash window remains. It does not justify
  another durable raw-result cache or operation ledger.
- Native Tool display descriptions reference the canonical result in the same
  commit; they do not carry a second result body. Observation previews retain
  their HTTP/SSE-only role and do not enter model history.

No change to the PG/Kafka/Worker/Cube authority split is indicated by this review.
The proposed repairs fit the existing adapter and Storage query boundaries.

## Verification and reproduction

109 existing tests pass across nine files: native Session/Runner, image-result
settlement, workflow cancellation, Tool presentation/error classification,
Worker adapters, and real PG Durable Storage conformance. Seven additional
review characterizations pass in two files. They intentionally reproduce the
baseline's defects and must be replaced/updated when a repair is implemented.

```sh
node scripts/run-with-test-postgres.mjs -- npx vitest run \
  scripts/experiments/review-worker-harness-20261018 --maxWorkers=1
```

The [settlement evidence](../../scripts/experiments/review-worker-harness-20261018/settlement-evidence.json)
and [cold-read evidence](../../scripts/experiments/review-worker-harness-20261018/cold-sequence-evidence.json)
are generated by the accompanying tests. Pi Durable/AI/Chord are the installed
1.0.0 packages. Model responses are scripted, image bytes/blob IO are synthetic,
and PG uses the disposable test wrapper. No paid model, live Cube, production
database or host restart is used. The test database/container is removed.

The initial line-count assertion counted the native retained trailing newline
as an extra line; counting nonempty fixture lines corrected that assertion.
The missing final decision and the 2,000 retained lines remain reproduced.
Private test logs are `/tmp/pi-cloud-worker-harness-review-baseline.log` and
`/tmp/pi-cloud-worker-harness-probes-all.log`.
