# Session seal publication repair and delivery

Decision: [ADR-0260](../adr/0260-session-seal-publication-lifetimes.md).
Review baseline: `f5bb08ed`. Implemented, verified and deployed on 2026-10-19 as
`seal-publication-8d9e7bc2`, source revision `8d9e7bc2`.
The Control Plane image is
`sha256:bcbc51ffca3194ec394bbe7a0f9a64f4e9d2bb4b746953bcc82ff42f3b290dda`.
Schema 190, execution v17, reply v3, guest 7, completion 3, preview 2 and Cube
management 7 are unchanged.

## Behavior

- A Control Plane-owned four-connection direct-PG pool bounds publication
  acquisition and checkout to five seconds each. It covers Outbox work, closure/
  control authorization, binding metadata and synchronous binding propagation.
  It uses the existing checkout eviction adapter and is independent of ordinary
  API/projection and expiry maintenance pools. Individual queries finish before
  Kafka/HTTP waits; no new queue or authority is introduced.
- A closing relay reports unavailable and starts no delivery for a late claim.
  Its immutable rows remain pending for the next claimant. After a partition
  ownership change, callers wait for the old request/writer to finish disposing,
  then retry under their own current ownership if necessary. Same-owner calls
  remain coalesced; three PG authorization reads and closed-evidence reuse remain.
- The Kafka reader stops new transaction admission and joins every outstanding
  group transaction before disposing its consumer, including external Session
  seal writers. Concurrent disconnect callers share one promise. Ownership is
  rechecked after the offsets callback; stale transactions do not request commit.
- A failed peer connection/body read invalidates only the address that request
  used. A late old request cannot erase a newer route. The unknown outcome still
  returns to the caller; existing Outbox retries rediscover and reuse the same
  Fact ID. There is no immediate blind resend or changed Tool replay behavior.

The measured local, no-binding seal remains six client SQL statements, including
three authority checks at distinct boundaries. That is not the SQL count for
whole recovery or for Sessions with active binding propagation.

## Verification

The first focused run passes 51 tests in ten files, including nine PG/HTTP
publication cases, two controlled reader-lifetime cases and startup pool cleanup.
Control Plane typecheck passes. The new tests cover bounded claim/authorization/
binding lock waits, late claim preservation, ownership coalescing and writer drain,
route rediscovery and a late old failure after a new route is cached. Existing
partition progress and producer/Projector guards remain covered.

The complete monolithic CI passes on this implementation: **1,924 workspace
tests across 22 packages**, 79 acceptance helpers, nine real RF3/PG transport
cases and 311 deterministic fault cases in 93 groups. Eleven environment-gated
workspace cases are skipped in the ordinary run; nine Kafka cases run in the
separate transport gate and Sandbox live behavior is covered below. Types,
native Cube/Helm/source policies, builds and dependency checks pass. Eleven
artifact scans and matched preflight pass before the drained deployment.

A standalone format precheck initially references deleted experiment files
which have not yet been staged. Staging those removals resolves it before the
passing CI. No product behavior or test assertion is relaxed.

Reader callback schedules use substituted native clients. They prove retirement
ordering without a native-library crash experiment. Real Kafka fencing and
recovery are verified separately by the maintained RF3/PG contract.

## Live acceptance and retained failures

All checks use GPT-6 Luna and owned fixtures on the deployed source:

- Native input: five cases pass, including pending edits/Stop, same-Run Worker
  replacement and simultaneous Worker/Control Plane loss. One SSE connection
  accepts generation 1 → 2 activity and fresh Cube evidence. Stop preserves 156
  observed characters; dual-process recovery preserves 124, with no PG streaming
  bodies. The expected injection-time kubectl connection error is accompanied
  by confirmed container exit 137 evidence.
- Real browser: a lost admission reply, Stop, returned image, new resend identity
  and direct vision pass. ASCII/Unicode Read results remain valid UTF-8 and use
  the native 50 KiB boundary (51,200 / 51,196 content bytes).
- Images: 6,294,601 / 6,294,277 / 25,128,663-byte sources use canonical reference
  records of 596 / 596 / 597 bytes. A different Worker Boot correctly recalls
  all three visual rankings. The **first** cold recall fails while CLIProxyAPI
  records `chatgpt.com` TLS handshake EOF. An unchanged fresh-fixture repeat
  passes; that repeat also records two approximately 120-second model requests
  with no upstream headers/response bytes before eventual success. These are
  retained transport limitations, not a claimed proxy repair.
- Native child handoff: compatible Control Plane replacement takes 13,085 ms.
  The same Worker/native child continues, its control reply is recovered and
  the effect occurs once. Physical cleanup passes.
- Complete Control Plane outage: unavailable for 63,918 ms; ready 8,048 ms after
  restoration is requested. Both idle/busy Worker Boots, the active Session lease
  and physical VM remain unchanged. Both Bash operations execute once and
  retried intake retains one identity. The watchdog receipt confirms restoration.
- Full Cube: the first attempt passes chat, coding, preview and warm/background
  reuse, then fails its large-Workspace model request with another TLS handshake
  EOF. Its owned tenant/foreign project are physically cleaned before retry.
  After the owner confirms switching the upstream proxy node, the **unchanged**
  suite passes: 21 model requests, five terminal outcomes, 35 native entries and
  173 projected mutations. Pure chat creates no VM. The 1,024 numbered files
  survive a fresh VM attachment; Volume file counts are 1,025 initially and
  1,026 after writing the requested restoration proof. Late Tool/cancel admission
  on the deleted VM is rejected, and final-conversation release passes.

The failed full-Cube driver leaves the previous successful public report intact.
That older revision/date was not counted as current evidence; only the later
accepted report for `8d9e7bc2` supports this release.

## Cleanup and limits

Normal API deletion and confirmed native absence precede metadata removal.
Final cleanup removes six owned S3 images, four bootstrap-tenant fixture
projects/Workspaces and the successful full-Cube tenant. The earlier failed Cube
tenant and its exact same-suffix foreign project were already removed separately.

All seven original account/configuration/credential fingerprints match: 32
tenants/users/API credential records, five password records, 35 model profiles/
credential bindings and zero SCM credentials. Final PG projects, Workspaces,
Sessions, Runs and image rows are zero. Native Volumes, node references, holds
and open allocations are zero; both Workers and all 28 serving Pods are Ready.
Windows and WSL web checks return HTTP 200. Disposable test containers/networks
and the temporary build proxy are gone; approximately 400 GiB remains free.

Production has two Workers on one compute node. Cached-peer cases use loopback
HTTP and controlled schedules; this does not establish physical-node HA or fleet
capacity. Provider TLS/response stalls remain external to this repair. No Tool
replay, native abort, storage ownership or VM-destruction authority is changed.

[Sanitized delivery evidence](seal-publication-repair-20261019.json) separates
source, artifact, live, failed-sample and cleanup results.

Original defect characterizations remain in Git at the review commit; maintained
regressions replace them. This work does not advance the reading checkpoint past
publication: Kafka → Projector closure/checkpoint/release is still the next hop.
