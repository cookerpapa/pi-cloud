# Native text presentation, 2026-10-12

Deployed: `native-text-c9b8b2a3`, source
`c9b8b2a32702d5a4968f767bca80cb1cf2c8ee3a`, schema 187, execution-topic v15.
PiCloud Helm revision 40 and Cube revision 79 completed the maintained matched
release. All required functional scenarios have passing evidence. Intermittent
upstream model TLS failures remain an operational issue, described below.

## Change

[ADR-0245](../adr/0245-native-commit-text-presentation.md) keeps complete Pi Storage
batches unchanged. Runner prepares text descriptions before their existing Kafka
ACK; Projector resolves them using the same native batch/current materialization.
The standalone assistant-text producer and its second text cache are removed.

Run display sequence, native sequence and Kafka offset retain their distinct
meanings. The shared owner serializes native and ordinary publications. Entry
projection commits display coverage atomically; covered replay references are
skipped before resolving a current native value. Each child Run gets its own
boundary even when another Run anchors the publication. The SSE/client protocol
settles active text to its canonical Entry identity before a recovered Task starts
another response. Finalization also clears text blocks omitted by the completed
message. Later non-text coverage cannot hide a newer partial.

PG streaming-body/checkpoint retention remains ADR-0244. No alternate text store,
extra text lookup, Pi Harness in Control Plane or second execution authority is
added. Schema 187 is a drained-cutover guard; private execution transport is v15.
The obsolete v14 topic and its PG projection offsets were removed only after
confirming no remaining native history, replay references, writers, Runs or
pending Outbox work.

## Source verification

- Whole-workspace type checking, source build, formatting, runtime policy and
  documentation checks passed.
- Across 22 workspaces, 1,701 tests passed and nine were skipped by the configured
  suites. The first broad run started during implementation and loaded the old
  child-boundary implementation in one Control Plane test. A final complete
  Control Plane rerun passed all 331 tests (four configured skips); the remaining
  workspaces passed. The initial failure is retained in the private evidence.
- The final removed-block correction passed Worker type checking and 41 targeted
  native Runner/text/frontend tests. These cover actual native messages as well
  as append, replacement, truncation, phase-only updates, Unicode, recovery and
  canonical/SSE merging.
- Real Kafka transport: seven tests passed. Deterministic fault evaluation:
  247/247 cases passed. Acceptance helpers: 64 tests passed.
- Real PG tests verified live reconstruction, covered-reference skipping,
  parent/child display destinations and delayed-ACK publication ordering. Native
  storage contracts retained their cold-read and acknowledged-overlay behavior.

The reproducible serialization experiment is
`scripts/experiments/native-text-20261012/measure.ts`. For 100 UTF-8 chunks plus a
final Assistant Entry, with byte-identical native batches:

| | Before | After |
| --- | ---: | ---: |
| Kafka records for this text workload | 201 | 101 |
| Serialized bytes, before Kafka compression | 604,793 | 452,702 |

It removes 100 additional publications and 152,091 bytes (25.15%) in that fixture.
This is an isolated wire comparison, not production throughput or a claim that
Pi never repeats text in its own live state and final Entry. Common non-text
traffic is excluded from both sides.

## Matched release and real-model acceptance

The final candidate's 11 images passed the maintained provenance, SBOM and
vulnerability gate. Writers drained and every recorded Cube node confirmed zero
VMs before cutover. Guest identity remains
`70d59dfbeb18c8b31d63048f38cadeb9deb93ea8`; completion identity is
`7e928938118ae58795faf9ab8cedd8cc2ac61cd7`.
Guest input / Tool Worker / Cube management protocols remain 4 / 4 / 7.

All real model checks used GPT-6 Luna:

| Check | Evidence |
| --- | --- |
| Native input, edits, retry identity and Stop | Same Run, native queue and returned inputs verified |
| Streamed text and Stop | No ongoing PG streaming bodies; native interrupted reply retained |
| Worker recovery | Actual exit 137, new lease, same logical Run and pending input recovery |
| Worker + Projector recovery during text | Both processes exited 137; current live state and partial reply reconstructed; same Run completed |
| Browser and images | Real browser lost-reply/Stop/edit/resend; same upload ID and direct vision verified |
| Large Read | ASCII and Unicode source truncation, valid UTF-8 and canonical diagnostics verified |
| Multiple Conversations | Supervisor reply, Agent messaging, parallel children, child cancellation and guest boundary each have passing evidence |
| Full Cube regression | Chat without VM, KVM coding, preview, warm reuse, surviving background process, 1,024-file fixture and fresh-VM Volume restore passed |

The native-input driver passed its complete five-scenario run on the third
attempt. Browser/image acceptance and the full Cube suite passed. Three complete
multi-Conversation attempts were interrupted by upstream TLS failures; their
passing supervisor/messaging cases were retained. The existing
`PI_CLOUD_LIVE_SUBAGENT_SCENARIO` selector then verified parallel, cancellation
and guest-boundary cases individually. This is cumulative scenario coverage,
not a claim that the whole multi-Conversation script passed in one uninterrupted
attempt. All unsuccessful fixtures were also physically cleaned up.

Private evidence lives in `dist/releases/native-text-checks/`; the scanned final
candidate is `dist/releases/native-text-c9b8b2a3/`. Representative reports are
`native-input-third.json`, `browser-image.json`, `production.json`,
`subagent-second-failed.json` (two passing scenarios), `subagent-parallel.json`,
`subagent-cancellation.json` and `subagent-boundary.json`.

## Observed limitations and cleanup

The provider gateway intermittently failed while connecting to
`chatgpt.com/backend-api/codex/responses`, with `utls: TLS handshake: EOF`, usually
after about three seconds. One observed failure took about 5.2 seconds. These
failures interrupted two native-input attempts, three multi-Conversation attempts
and the first focused guest-boundary attempt. Failed reports and gateway evidence
are retained. No cloud retry policy, native settlement or test assertions were
weakened. The earlier [TLS investigation](model-egress-tls-20261012.md) remains
relevant; the remote AnyTLS mechanism is still an inference without node evidence.

Initial image builds also saw Debian downloads fail through the operator's proxy.
The successful build used direct Debian downloads; Docker Hub metadata access was
slow. Runtime model proxy configuration was preserved. The owned temporary build
forwarder was stopped after preparation.

All acceptance tenants and owned project/Workspace metadata were removed only
after product deletion, writer closure, Volume purge and positive native VM
absence checks. The final state/preservation report records the original account,
model/provider configuration and credential counts and checksums. No old business
backup or legacy text reader was retained.

Final checks confirmed zero Sessions, Runs, native commits, projects, Workspaces,
active writers, VM ownership, development machines and terminals. Control Plane
and Web were 1/1 Ready; Workers were 2/2 Ready. All recorded nodes were scanned
and contained zero VMs. Original counts remain 29 users, 29 tenants, 30 model
profiles, 30 credential bindings, 29 API credentials and four password credentials.
Account/configuration/credential fingerprints match; API credentials differ only
in their expected `last_used_at` activity timestamps.

A private fixture cleanup helper initially compared a Date through a string that
dropped milliseconds. Three already-purged test Workspaces retained metadata.
The helper was corrected; explicit recorded fixture IDs, names, creation times,
released ownership and native absence were rechecked before removing those rows.
The final zero-resource check includes these residuals.
