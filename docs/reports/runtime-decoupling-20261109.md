# Runtime decoupling and continuation delivery

Status on November 10: implementation, consolidated serial source verification,
commit/push, matched rollout and live acceptance are complete;
the detailed results below distinguish passing cases from failed earlier samples.

## Scope and issue audit

The owner authorized implementation of Issues #17–#23 on November 9. #24 tracks
the final assessment of remaining Cube patches. The audit found related concerns,
not duplicate issues: #19 owns interval valuation while #23 owns provider facts;
#20 owns result delivery, #21 owner replacement, and #22 environment recovery.
Their discussion-only status was updated. Later same-Run recovery decisions
supersede the original callback-only assumptions.

[ADR-0306](../adr/0306-runtime-decoupling-and-continuation.md) records the accepted
ownership and protocol changes. Important decisions from the discussion are:

- The execution owner initiates finite retention and full reply-path probes.
  PG leases remain authority; missing probes never authorize VM destruction.
- A fixed Guest application can use ordinary provider execution APIs and an
  HTTPS completion endpoint without exposing Kafka to the Guest.
- Pending operations retain their original reply destination, read position and
  deadline across Worker replacement. Reattachment never republishes the shell command.
- Infrastructure interruption can continue the same Run. A changed environment
  must be verified and recorded before the next model request; user Stop remains terminal.
- Providers supply lifecycle facts/coverage, while PiCloud derives intervals and
  applies its own prices. Diagnostic probes are not a billing clock.
- Zero Cube source patches is an assessment outcome. Existing independent
  admission, cancellation and physical cleanup guarantees cannot simply be removed.

## Implemented source slices

| Issue | Source behavior | Delivery state |
| --- | --- | --- |
| #17 | Separate public Session API, private projection/live stream, deployment and release roles | Live API replacement passed |
| #18 | Execution-side batched eligibility, finite retention, passive Worker probe receiver | Full probes and actual 30-minute idle expiry passed |
| #19 | External interval derivation, own prices and atomic source cursor/receipt settlement | PG contracts and live accounting passed |
| #20 | Guest HTTPS callback, scoped capabilities, independent receiver, no Cubelet Node adapter | Live text, lost result/ACK, UNKNOWN history and images passed |
| #21 | Current pending-reply index, protected original topics, native safe proxy reattachment | Live Worker loss / same-Run continuation passed |
| #22 | Current environment observation/recovery gate and atomic model-visible reset | Live owned VM loss / same-Run continuation passed |
| #23 | Bounded raw Cube lifecycle history and provider source port | Native contracts and live cursor/replay checks passed |
| #24 | Final remaining-patch review | Complete; native admission/cancellation and lifecycle patches remain |

The isolated Cube worktree is `/tmp/picloud-cube-0306`, based on pinned upstream
`4411c96ba8658a959de34693f54f4918db2a432f`. Its private baseline commit is not an
upstream contribution. Changes are exported into the maintained two-patch stack
with hashes in `deploy/cubesandbox/runtime-build.json`; builds use that stack.

The matched target is schema 215, Session Kafka transport v19, reply transport v4,
native Cube protocol 9 and fixed Guest child protocol 7. Existing native history,
accounts, model/provider configuration, credentials, Workspace bytes and stable
machine intent must survive compute-only retirement. Protected old live suffixes
must be materialized before discarding retired transport resources.

## Verification evidence so far

- The initial serial workspace run covered 24 workspaces: 2,448 tests passed,
  16 failed and 13 were environment-gated. The failures were fixed and the affected
  nine files passed a targeted 109-test rerun. New startup-cleanup and scheduler
  fairness cases were added. Type checks passed after the fixes.
- The operator/helper suite initially passed 281 tests with three failures and one
  environment-gated case. Release-role provenance and Guest image COPY inputs
  were corrected; targeted reruns passed.
- The final source-contract pass passed 31 tests, including atomic lifecycle
  collection, source scheduling fairness, HTTPS acknowledgement and image inputs.
- Real isolated RF3 Kafka/PostgreSQL transport tests passed ten cases initially.
  One binding-close convergence assertion used Vitest's one-second default; the
  targeted rerun passed with the existing ten-second convergence budget used by
  the rest of that fixture. It verified closed-view restoration and 100 memory
  route reads without SQL. Original-topic Worker replacement and historical
  result recovery passed; no accepted operation was republished.
- Dependency setup, documentation, installation, runtime policy, Helm render and
  distributed preflight, observability and image closure/context checks passed.
  Browser production build passed after separating Node-only completion capability
  code from the browser protocol entry point.
- An isolated real HTTPS callback/codec test processed eight normalized images
  (about 10 MiB each) and published eight claim-check results. Combined client,
  server and synthetic image generation peaked near 817 MiB RSS; this is not an
  aggregate production memory limit or a live S3/Kafka/VM measurement.
- Native admission/race, allocation, execution, lifecycle, Volume and service
  contracts passed. The final fault manifest's 402 cases passed across the initial
  run and targeted reruns, including refreshed probe fixtures and pending-reply
  Topic/image retention checks.

The initial review of test failures also found and fixed an actual startup leak:
Provider cleanup is registered before loading the callback CA, so a missing CA
cannot leave the acquired transport alive. The observation helper now distinguishes
an explicit reconnect grace period from stale evidence. Source scheduling gives
untouched nodes priority over sources continuously catching up.

Live fault operators now modify only an owned HTTPS completion Deployment template
through a reversible preload. They no longer mutate Cubelet Node source files.
The removed reverse-stdin receipt fixture is replaced by a scoped lost-HTTP-ACK
case checking one command execution and survival of completed background work.
Cleanup evidence combines raw capture cycles, the journal head and the accounting
cursor, rather than the removed Cube-side compute billing outbox.

Temporary verification logs are `/tmp/picloud-0306-tests.log`,
`/tmp/picloud-0306-tests-results.json`, `/tmp/picloud-0306-rerun.log`,
`/tmp/picloud-0306-helpers.log`, `/tmp/picloud-0306-last-contracts.log`,
`/tmp/picloud-0306-transport.log`, `/tmp/picloud-0306-transport-rerun.log` and
`/tmp/picloud-0306-native-results.json`. These are local working evidence, not
committed transcripts or credentials. They do not substitute for the live reports below.

## Delivery checklist

- [x] Finish native, fault, dependency and browser checks; fix failures.
- [x] Commit and push the completed source change.
- [x] Prepare the maintained matched release and scan its images.
- [x] Drain/fence writers and retire compute while preserving Workspace bytes.
- [x] Install TLS/new roles/schema/transports; remove retired resources after confirmation.
- [x] Run relevant live API/Worker/VM/reply/retention/accounting acceptance serially.
- [x] Publish #24's evidence-based remaining-Cube-patch assessment and close delivered issues.

The previously deferred approximately 131 MiB upstream model-upload experiment
remains out of scope. Model acceptance uses GPT-6 Luna.


Before live acceptance, the serving PG inventory showed two running-intent
persistent development machines and no unfinished Runs. The live VM-loss fixture
therefore defaults to its own allocation only; whole-node loss remains an explicit
option requiring an otherwise empty node. User Workspace bytes and machine intent
are preserved throughout the matched release.

## Matched rollout and initial live acceptance

Source `03adcddc` was committed and pushed. All 14 matched images passed the release
scan and the full native chart preflight. Operator correction `733efa4e` reads the
actual deployed accounting domain ID when checking cleanup cursors.
`runtime-decoupling-20261110-r1` was deployed after ordered writer drain, confirmed
retirement of both old dedicated allocations and XFS Workspace verification.
Schema 215 and the new API/completion roles are ready; both persistent machines
returned to running intent/ready state with their stable identities and files.

The first live check found the self-hosted metering network policy still allowed
443 while its Cube API is on 3000. Commit `eb9d4487` corrects the maintained
self-hosted values and adds a rendered policy contract. Whole-manifest comparison
confirmed only the metering NetworkPolicy changed, then Helm revision 153 applied
it without changing Pod templates. Lifecycle history now reaches accounting.
The deployment journal records this verified configuration revision while all
image source provenance remains `03adcddc`.

Four GPT-6 Luna native-Tool Runs passed, including read/write/edit/Bash, source
truncation and local Tool-error handling; owned resources were cleaned. Rolling
replacement of the public API passed with the same Worker/Projector and one Bash
effect. Abrupt Worker replacement re-admitted the original Run but could not
finish its environment check. A live read-only query isolated PostgreSQL 42703:
the maintenance query incorrectly joined a nonexistent `supervisor_hosts.boot_id`.
The boot identity already comes from the authorized Worker row. That extra join
predicate is removed and real PG tests now cover accepted readiness, mismatched
boot/fencing and closed binding admission. The narrow execution-maintenance
repair uses the existing Session-runtime replacement contract; its successful
revalidation is recorded below. The failed first sample is not counted as acceptance.

The maintenance correction was published independently as
`runtime-maintenance-20261110-r1` (source `063d2223`, Helm 154). The repeated real
Worker SIGKILL acceptance passed: a replacement completed the original Run, the
Bash start/end file showed one effect, and fixture cleanup completed.

The reply-fault driver then exposed an early-Stop race before installing its fault
preload: the user cancellation signal reached the local model gateway before it
issued runtime metadata, so the Harness never reached native cancellation
settlement. The local gateway now returns metadata with an already-revoked
capability only for explicit user Stop/timeout; owner loss still refuses a grant.
Requests with that capability return 401 without contacting the provider. The
Worker bootstrap repair checks passed 8 files / 106 tests. Its independent image
was published as `worker-bootstrap-20261110-r1` (source `20d80592`, Helm 155).
Repeated early-Stop checks passed with zero Tools and zero VM activation.

## Subsequent serial live evidence

Owned VM removal passed in `acceptance/vm-recovery-verified.json`: the original Run
completed after verified replacement, exactly one original Bash call remained,
`pi-cloud.sandbox_reset` was committed before continuation, and the unrelated
dedicated VMs remained present. A truthful executor failure is a settled Tool
outcome, so the old assertion allowing only completed/unknown was corrected to
also allow failed; this did not change product recovery semantics.

Lost-result and lost-result-plus-probe cases passed in the reply reports. A healthy
fresh path allows UNKNOWN followed by effect inspection; an unconfirmed path keeps
the Run interruptibly waiting. Neither case redispatched the original Bash or
replaced the physical VM. Lost callback ACK caused two deliveries and one execution;
completed background work survived. Probes did not enter native history.

The first browser assertions failed: one redeclared a global CDP variable, another
blindly scrolled a virtualized list, and the last operated disabled controls before
opening the Session. Screenshot diagnostics showed the New Chat page. Canonical
UNKNOWN results for both fault cases were still present. The focused
`acceptance/reply-history-focused.json` passed after waiting for the selected chat
and using its actual history search cursor. This is an operator-fixture correction,
not a hidden product-state fix. Failed reports remain available as local evidence.

The retired v18 Session Topic was deleted after checking zero native replay
references, old pending reply references, unfinished old-topic Runs and unreleased
old-topic owners. No v3 reply Topics remained. Current v19/v4 transports were retained;
`acceptance/retired-transport-cleanup.json` records the checks. Owned fault templates
and resources were restored/cleaned before starting the next serial check.

`acceptance/execution-probe-verified.json` passed: pure chat allocated no VM,
the full Projector/Cube/Worker path confirmed while Bash was still executing,
no probe entered native history, an old boot was rejected, direct observation
worked with an undeliverable callback, a paused VM was not woken, and resume
restored the path. The first fixture attempted Pause while its deliberately lost
callback probe was still an active exec; Cube correctly refused the snapshot.
The corrected fixture waits for that probe's bounded lifetime before pausing.

`acceptance/images-repeat.json` passed three immutable image claim checks of about
6, 6 and 24 MiB. Native records were 596–597 bytes, hashes matched stored originals,
and a replacement Worker correctly recalled all three charts without reading the
overwritten source file. The first sample delivered/stored the bytes successfully
but Luna reversed two bars in the final chart. That stochastic visual-answer
failure is preserved in `acceptance/images.json`; the repeat did not relax the
comparison. This is one-host acceptance, not a model-accuracy or fleet-scale claim.

`acceptance/resource-accounting.json` passed and cleaned its owned tenant. Two
Sessions used one allocation; the real kernel enforced the 1 GiB Workspace limit
and its growth to 2 GiB. A 56.576-second stable paused window had zero confirmed
compute milliseconds while storage continued. Repeated Workspace receipts and two
stale lifecycle pages did not duplicate accounting facts. Statements/export matched
the interval ledger; an unconfirmed interval remained unpriced. No tariffs or
payment collection were enabled. A subsequent one-node observation measured the
metering container at about 142 MiB with a recorded cgroup peak near 162 MiB
(including its Node launcher and service). This is not a fleet benchmark.

`acceptance/elastic-retention.json` passed and cleaned its owned tenant. A single
pending Tool overlapped periodic renewal without issuing another Tool. After
settlement, the actual 1,800,000 ms policy expired; the measured idle wait was
1,808,010 ms, ending at 00:51:31 UTC. Cube confirmed physical absence, management
adopted it, and Luna continued on a new allocation with the same retained file and
a model-visible reset entry. This fixture did not stop the shared Session-runtime
process for the whole idle window; outage/freshness boundaries have separate
contracts.

Final recovery checks passed 15 tests in three files against isolated RF3 Kafka
and real PostgreSQL. They include a second Worker replacement while an original
reply remains pending, reply arrival during restoration, protection of the old
Topic's suffix, and preservation of an image after old-writer closure until native
settlement. The operator release helpers passed 40 tests and the affected runtime
types passed. These were run serially after the live retention fixture completed.
Final inventory found no unfinished Runs, no pending Workspace physical purges
and no owned acceptance tenants. Both original running-intent development machines
remain; all enabled application workloads are ready.

## Final Cube assessment

[#24's source inventory](../research/cube-patch-assessment-20261110.md) concludes
that the execution path is **not yet patch-free**. Fixed Guest application code
is not a Cube source modification, but Cubelet still owns the external operation
gate, exact cancellation, process-scope lifetime and bounded launch-failure
delivery. Ordinary provider APIs can launch a future Guest operation service;
their PID/command interfaces alone do not replace those guarantees.

Allocation closure, Volume proofs, finite expiry, raw lifecycle history and
independent upstream fixes are a separate remaining patch set. This release
does not delete them or enable an alternate production backend. The next
execution-only replacement needs its own verified vertical slice; its design
candidate and failure requirements are documented, not silently implemented.
