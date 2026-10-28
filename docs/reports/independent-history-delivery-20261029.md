# Independent Forks and native history retention

Deployed as `independent-forks-final2-20261029`, source
`aa0240c28422fcc70298b0f9be46245d5b62c011`, schema **203**, Helm **123**.
[ADR-0284](../adr/0284-independent-forks-and-history-retention.md) describes the ownership contract.

A completed source prefix can be forked while later work runs. Pruning the closed
source preserves its independent Forks, including a running Fork. Each Fork reads
its own history, tool relationships and input/image metadata. Focused navigation
also works when the original parent anchor is no longer visible.

Immutable Entry bodies are shared through tenant-scoped references. Frozen Turn
headers and presentation relationships are retained data; they do not create
executable Runs or pending input. Native document `asOf`/`current` policies use
Pi's public Storage/Conversation APIs. Cold pruning rebuilds the retained physical
family, verifies it, switches bindings atomically and retires the closed old store.
The existing image store owns image bytes and final-reference cleanup.

## Verification

- Workspace typechecks and tests pass, including **545 Control Plane tests** and
  **119 acceptance-helper tests**. The targeted native Storage/family reopen cases
  also pass. Existing optional environment-gated tests remain explicitly skipped.
- **375/375 deterministic fault cases** pass. Actual PostgreSQL/Kafka transport
  acceptance passes **9 cases**. The ordinary native projection remains at its
  existing **10 SQL** round trips; body interning and reference insertion share a
  single statement.
- An owned real **GPT-6 Luna/Cube** fixture forks C during source Run D, then prunes
  the source to B during Fork Run F. The Fork recalls C and serves the retained
  image; the source continues from B without C. Native compaction and subsequent
  model recall preserve C in the Fork. Real browser focus navigation passes.
- Final-image Cube acceptance passes real Bash cancellation, lost-reply handling,
  Stop-return/resend of the same attachment, screenshot/show-image display and
  preview navigation. Native Read retains the default 50 KiB boundary and valid
  UTF-8 truncation.
- Final-image native-input acceptance passes consume/edit, Stop, Worker crash,
  stream Stop and simultaneous Worker/Control Plane crashes. Native partial text
  and queued-input identities survive, with no PG stream-body history added.

## Measured cost

The composed test uses **1,073,973,615 bytes** of synthetic native history, actual
PG/API/SSE, and the real browser. Pagination, search, streaming export, navigation,
virtualized disclosure, stationary-edge loading and live output while browsing
pass. Browsing retains roughly **16 MB** of JavaScript heap in this sample.

After two Forks and source retirement, **33,316** retained Entry bodies across
three physical histories occupy **1,067,469,387 logical payload bytes once**.
Frozen descriptors occupy about **1.61 MB**. The three histories' native-write,
record-index and presentation-reference rows occupy about **86 MB** combined,
excluding index pages, WAL, TOAST and other physical storage overhead.
The deliberately discarded 600-entry suffix loses its final references and is
collected. Peak test-process RSS is about **736 MiB**.

A native point lookup reads **one body through its primary key**, about **5 ms**.
The latest history window takes about **100 ms / 8 SQL** and returns about **2 MB**.
Import still parses and validates native records: the first Fork takes about
**151 s**, nested Fork **87 s**, and cold pruning **206 s** for this 1 GiB case.
These are single-host measurements, not fleet latency guarantees or constant-time
Fork claims. Source projection counters remain writable during Fork copying;
cold pruning occupies the selected family's admission boundary.

## Release corrections

Remote CI identified Undici 6.27.0 bundled inside the guest's global npm. The old
local guest scan covered only OS packages, so root npm audit did not catch this
separate dependency tree. The guest now pins **6.29.1** and local/CI scans cover OS
and language packages. Guest inventory must include Node, Python and Go. Chromium
and Java analysis use owned disk scratch; image scanning remains offline.
All **12 final images** pass the complete gate, and source CI is green.

The first image fixture used a one-pixel PNG with an invalid IDAT checksum. Its
failure was retained and its resources cleaned; the valid Sharp-generated fixture
passes. The native-input driver now checks the schema-203 matched contract.

## Original assets and cleanup

Before/after checks preserve all **3 original conversations**, **5,254 commit
records**, **3,770 logical history rows**, **41 current-state rows**, **5,859
Workspace files**, **27 configuration/credential hashes** and **65 referenced
images**. Native records are compared semantically across their representation
change; original wire fingerprints remain unchanged. Expected server log/PID
changes are excluded from file-byte comparison.

Compute retirement confirmed absence on the recorded node while keeping machine
intent and the existing Workspace Volume. The original application on port 4188
was restarted with the same HTML hash. Final inventory has **29/29 ready Pods**,
zero active Runs/writers/Tool bindings/elastic fixtures, and the retained machine
at generation 25. Owned live-test tenants, Workspaces and images are removed.

Private evidence is under
`deploy/production/runtime/release-evidence/independent-forks-20261029/` and
`deploy/production/runtime/work-evidence/main-latency-forks-20261028/`.
The temporary schema-202 rollback export is removed after the final preservation
checks; it is not a retained development-era business backup.

The separate [first-request investigation](first-model-request-comparison-20261028.md)
reproduces large WebSocket upload failure and HTTP fallback in both native Pi and
Codex through the installed provider route. This release does not claim to repair
that external proxy path.
