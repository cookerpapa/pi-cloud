# Runtime decoupling and continuation delivery

Status on November 10: implementation is present; consolidated serial source verification
has completed. No root-repository commit, push, matched image build or rollout has
occurred for this batch. Existing release evidence is not acceptance for these changes.

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
| #17 | Separate public Session API, private projection/live stream, deployment and release roles | Awaiting live API replacement |
| #18 | Execution-side batched eligibility, finite retention, passive Worker probe receiver | Awaiting live probe/retention acceptance |
| #19 | External interval derivation, own prices and atomic source cursor/receipt settlement | PG contracts passed; live collection pending |
| #20 | Guest HTTPS callback, scoped capabilities, independent receiver, no Cubelet Node adapter | Unit/TLS/Guest contracts passed; live acceptance pending |
| #21 | Current pending-reply index, protected original topics, native safe proxy reattachment | Native/PG/mailbox contracts passed; live Worker loss pending |
| #22 | Current environment observation/recovery gate and atomic model-visible reset | Native contracts passed; live VM recovery pending |
| #23 | Bounded raw Cube lifecycle history and provider source port | Native compilation/contract verification in progress |
| #24 | Final remaining-patch review | After matched delivery and live acceptance |

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
- Standalone native admission/race contracts passed. Full Cube allocation,
  execution, lifecycle and Volume contracts are currently running.

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
committed transcripts or credentials. KVM and the old deployment are available.

## Remaining delivery work

- [x] Finish native, fault, dependency and browser checks; fix failures.
- [ ] Commit and push the completed source change.
- [ ] Prepare the maintained matched release and scan its images.
- [ ] Drain/fence writers and retire compute while preserving Workspace bytes.
- [ ] Install TLS/new roles/schema/transports; remove retired resources after confirmation.
- [ ] Run relevant live API/Worker/VM/reply/retention/accounting acceptance serially.
- [ ] Publish #24's evidence-based remaining-Cube-patch assessment and close delivered issues.

The previously deferred approximately 131 MiB upstream model-upload experiment
remains out of scope. Model acceptance uses GPT-6 Luna.


Before live acceptance, the serving PG inventory showed two running-intent
persistent development machines and no unfinished Runs. The live VM-loss fixture
therefore defaults to its own allocation only; whole-node loss remains an explicit
option requiring an otherwise empty node. User Workspace bytes and machine intent
are preserved throughout the matched release.
