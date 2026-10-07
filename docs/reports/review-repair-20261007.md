# October 7 review repairs

Source implementation for the owner-approved
[review findings](repository-review-20261007.md), based on
`7a5fc6034a55d9fda98a25c8015112327ed2bfc4`. This record describes source changes
and isolated verification. Production deployment is not part of this repair turn.
The [210-case fault evaluation](review-repair-20261007-faults.md) passes; it is
deterministic fault injection, not a live production chaos test.

## Resulting behavior

- **R07-01:** first-message, ordinary-send and Steer paths share composer submission
  identity handling. A lost response retains the same immutable request identity;
  confirmation permits an intentional identical new message. Session, text,
  attachment identities and Steer target determine whether the submitted input
  changed. An older ACK cannot discard a newer pending request or erase draft edits.
  No prompt-text deduplication or server-side compatibility route was added.
- **Q07-01:** release evidence records release/source revisions separately and
  retains image IDs/registry digests. Reused guests are checked against the guest
  input hash reproduced from their original Git source. Other application images
  still require the release revision. Unknown source, changed guest input and
  malformed image digest fail. No immutable image tag is rewritten.
- **O07-02:** the reader selects the visible Session page before counting its
  Turns. Migration **182_conversation_activity_page** adds the matching activity
  index. Tenant scope, timestamp microseconds, pruning, empty conversations,
  started/unstarted cancellations and deleted-Workspace display are preserved.
  No additional query table or count authority was introduced.
- **O07-01:** [ADR-0234](../adr/0234-volume-gateway-shared-access.md) was recorded
  before implementation. Browsing/uploads use shared Volume admission;
  credential callbacks use a separate exclusive lock inside it; deletion still
  requires exclusive Volume access. The redundant process-local whole-Volume
  queue and its lock-free fallback were removed. Upload staging/hash/fsync/link
  behavior stays intact. Root absence can be presented as an empty read without
  creating storage or authorizing cleanup.
- **N07-01:** the Projector comment now describes native Durable abort settlement
  and independent physical cancellation delivery.

## Verification

The [machine-readable evidence](review-repair-20261007.json) records final command
results and probe measurements. Combined verification passes: all 22 workspaces
typecheck, **1,630 workspace tests** and **44 acceptance-helper tests** pass,
and the **210 fault cases** pass. The application build, full browser acceptance,
Helm/preflight, install contract, runtime budgets, image closure/build-context
checks and documentation verification also pass. Nine opt-in tests are skipped
in the default workspace run; RF3 transport and live KVM Provider acceptance were
not rerun in this source-only repair (the review's separate RF3 evidence is linked
from its report). Targeted checks cover:

- Actual browser retries after ordinary-send and first-image-message ACK loss,
  plus existing Steer, in-flight draft, queue, upload and navigation checks.
- Reused guest provenance against the existing local image and isolated Git
  fixtures, including application-image strictness and wrong/missing source.
- Conversation pagination/visibility and current-schema tests; an isolated
  5,000-Session/200,000-Turn query-plan measurement returns identical rows while
  reading **4,040** Turns for a 101-row SQL page. Three measured current queries
  took **1.1–2.2 ms**, compared with **117–133 ms** for the recorded old query.
  This is local query evidence, not a production API SLO.
- Real filesystem exclusion across Gateway instances and processes; normal and
  SIGKILL release, shared access, credential serialization, PG disconnect,
  replaced lock/envelope inodes, upload conflict/cancellation and deletion/reaping.

The first targeted pass exposed old test-only construction bypassing filesystem
locks: that bypass is removed, error classification is consistent, and the
empty-root read contract is retained. Initial test-only TypeScript literal/lib
errors were corrected before the combined verification; they are not hidden as
production failures or ignored checks. The independent browser probe was also
updated to reuse the maintained lost-response fixture after its old injection
duplicated a declaration; the full browser acceptance had already passed.

## Deployment and remaining decisions

Use the ordinary migration/bootstrap path for schema 182 and replace application
images together. The Gateway retains `Recreate`; drain its active requests for
upgrade/rollback. The Cube native protocol, guest build inputs, volumes, runtime
identities and historical UNKNOWN resources are unchanged by these repairs.
An index rollback does not change data authority, but the deployed application
and expected migration ledger should remain matched.

Request identity is local to the open composer. Reloading a page does not gain a
new durable draft feature. Continuous upload activity can still delay deletion;
a lock timeout never proves physical absence or releases quota. Cross-node
filesystem locking and clean-host installation remain separate acceptance work.

Partition dispatch redesign, broader Cube maintenance changes and wholesale
lifecycle/UI decomposition remain the review's discussion items. These repairs
extract the concrete duplicated submission/inspection logic and refine the
existing lock contract without adding another service or execution authority.
