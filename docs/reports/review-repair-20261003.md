# October 3 review repairs and acceptance

Status: implementation and local verification complete; matched deployment acceptance in progress.
Decisions: [ADR-0216](../adr/0216-review-data-path-bounds.md), [ADR-0217](../adr/0217-declarative-cube-release.md).
Baseline: [repository review](repository-review-20261003.md), `4294c759`.

## Implemented behavior

- R03-01: S3 uses SDK-owned connection/inactivity deadlines, including receipt waits;
  cancellation after GET headers closes the body. Progressing transfers have no new total-duration quota.
- R03-02: cancellation due/claim/retry and lifecycle timestamps use PG time, including
  the Worker's candidate query. App clock injection is removed from the authority path.
- R03-03: optional verification reminders certify the current completed mutation
  generation; later or overlapping edits invalidate older success. No new quality gate.
- O03-01: watched queue refreshes run outside ordered projection, coalesce by Session
  and version, retain bounded read slots through reset, and use a separate PG read pool.
  First-page SSE/API responses carry at most 20 inputs; continuation requires the
  same viewVersion. The browser preserves drafts through conflict and page invalidation.
  Total accepted inputs remain unlimited; all pages can be loaded.
- O03-02: exact native projection reads only affected Lane heads after the Session lock;
  sequence, identity, parent, replay and lock-freshness checks remain.
- O03-03: original images stream S3 → existing Cube temporary-file normalization port.
  Scoped consumers verify length/hash and close on failure/early return. Normalized
  native image content still materializes as required by Pi; no guest S3 credentials.
- O03-04: cancel scans exclude admissions without a local Run and Runs already joined
  by a cancel callback. A ten-millisecond polling fixture produces no additional
  queries during a 75 ms all-cancelling interval. Ordinary active fallback stays at
  one second; fleet-wide notification amplification remains a measurement item.
- D03-01/02: pinned chart/config inputs are transformed before Helm deployment.
  The same release owns final mounts, plugin/Master/completion configuration and
  credential-change fingerprints. Old post-deployment workload patches are removed.
  Completion copies only the database connection adapter, not migrations/domain
  sources. Its build verifies the actual native base version as well as source identity.
- D03-03: retain the shared process, with queue pool/concurrency isolation and streaming
  original bytes. This does not establish full CPU/GC or physical-node isolation.

Schema remains 168, Session log v13 and guest wire2. Public queue responses require
`afterPosition` and `hasMore`; matched API/Web replaces the old unpaged response.

## Fixed-workload data comparison

`node --import tsx scripts/measure-review-data-paths.mjs` creates/drops a fresh database
on an explicitly supplied isolated loopback PG endpoint (`PI_CLOUD_REVIEW_DATABASE_URL`).
It repeats the original 4,096-character input and historical-Lane fixtures.

| Work | Review baseline | Repaired |
| --- | ---: | ---: |
| First watched snapshot, 100 queued inputs | 428,309 bytes | 85,781 bytes |
| First watched snapshot, 500 queued inputs | 2,141,510 bytes | 85,782 bytes |
| Reachable inputs with 500 accepted | 500 | 500, through pages |
| Name append, 10,001 stored Lane heads | 10,001 heads / 428,926 bytes | 0 heads / 2 bytes |

The 500-input notification payload is approximately 96% smaller. Paging all inputs
still performs additional queries and transfers their content; do not interpret this
as eliminating data the user explicitly requests. Current `allPagesReadMs` and old
single-query timing are different workloads and are not latency comparisons.

## Verification and limits

Focused tests cover stalled/progressing S3, stream cancellation and integrity,
positive/negative clock skew, competing cancellation claims, verification overlap,
post-lock Lane freshness, queue read isolation/capacity/reset/paging, and read-pool deadlines.
Real Chromium checks passed edit/order/cancel/edited Steer, lost replies, drafts,
stale reads, mobile layout, paging conflicts and editing a later page.

The initial full workspace check had one failure: its startup-cleanup fixture returned
one mock database for both pools and expected one destruction. It now supplies two
pools and verifies each is closed once; all four focused startup tests pass. Other
workspace tests passed in that run. Acceptance-helper tests: 61 passed. Final fault
and release evidence will be appended after the matching cutover.

The real pinned Cube chart rendered 48 resources with synthetic credentials; final
mounts, config resources and specified images passed the deployment contract.
A local mutable base tag pointed to the older native patch set. That build was stopped;
the replacement uses a verified matching base. A deliberate mismatched patch ID now
fails the Docker build. The correct completion image's import smoke passed with no
migration source in its filesystem. This is separate from runtime preflight.

Helm, observability, image closure, runtime policies, installer contracts and the
high-severity dependency audit pass. Known moderate Fastify/Nest findings remain.
No physical multi-node HA or clean-host installation claim is added.
