# September 30 review: repairs and discussion decisions

Date: 2026-10-01. Starting revision: `7c1f46ec`.
Findings originate in the [September 30 review](repository-review-20260930.md).
This record distinguishes completed changes from work still under validation.

## Scope authorized after the review

- Preserve Worker → Kafka → Projector → Broker → Cube command delivery. The
  owner rejected the proposed Worker-direct dispatch alternative.
- Research Cube-owned execution acceptance and Kafka completion publication
  outside the untrusted guest, with Broker-restart independence as the target.
  Research does not authorize a silent Cube upgrade or a second task scheduler.
- Implement confirmed R30 findings and bounded cleanup without compatibility
  paths. Keep pinned Pi and its public execution/storage semantics.
- Delete conversations and their database history instead of archiving them.
  Reclaim unused elastic compute after its final conversation disappears;
  retain current between-Turn warm reuse and owned-machine release semantics.
- Preserve displayed partial Assistant text and confirmed interruption facts
  in subsequent model context, without replaying partial Tool calls or
  presenting unknown effects as successful execution.

## R30-07: direct-Steer runtime composition

The composition test now admits a real Run through the existing test Worker,
then accepts Steer with HTTP 202 and verifies its held source in PostgreSQL.
The actual application reconciler uses the injected remote transport despite
having no local Worker WebSocket connection. The transport reply is deliberately
blocked, proving API acceptance does not wait for delivery. A repeated request
keeps the same source/control identity and does not redeliver an acknowledged
input. No old `kind=steer` fixture or production compatibility branch remains.

Validation: all four `control-plane-runtime.test.ts` tests and the Control Plane
typecheck pass. The complete
release check will be repeated after the remaining review repairs.

## R30-08: installed dependency security

Pi remains 0.84.1. Patched dependencies are pinned: brace-expansion 5.0.12,
undici 6.28.1 / 8.10.2, fast-uri 3.1.8 / 4.1.5, Vitest/@vitest/mocker 4.1.11,
and @nestjs/platform-fastify 12.0.3. Fastify is aligned to the adapter's 5.12.4.
The October 1 audit also exposed the Nest middleware advisory indexed after the
original review; the patch follows its maintainer recommendation. The obsolete
find-my-way replacement is removed because the adapter now supplies 9.9.0.
The guest image's npm brace-expansion preparation uses the same patched version.

References: [Nest advisory](https://github.com/advisories/GHSA-9c5c-9qcx-q35q),
[Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9),
[brace advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr),
[undici 6 patch](https://github.com/nodejs/undici/releases/tag/v6.28.1) and
[undici 8 patch](https://github.com/nodejs/undici/releases/tag/v8.10.2).

The repository security gate passes with no remaining applicable findings.
Raw npm audit still reports the published Pi shrinkwrap's old nested versions;
it does not observe the installed preparation. The gate now compares each
reported affected range with the verified installed version at the exact
replacement node, using pinned node-semver. The static advisory URL allowlist
is removed. A new advisory affecting the installed version, unknown ranges,
another vulnerable installation, or an unprepared dependency stays visible;
an aggregate Pi finding is exempt only after every underlying dependency passes.
This is an installed-tree result, not a claim that raw npm audit exits zero.

Validation: 61 helper tests, 87 Pi/remote-tool contracts, 13 API/composition tests,
11 command-executor tests and 16 Projector handoff tests pass; Web build and image
closure check pass. Workspace typechecks were run; the one Vitest-4 Mock typing
change was corrected and runtime-core rechecked. New subprocess regressions
exercise deep brace nesting and unsolicited WebSocket subprotocols against both
installed undici lines. Future-advisory tests ensure audit exemptions fail closed.

## R30-01: unavailable Tool reply stops subsequent sampling

Rejected native-reply waits now notify the existing infrastructure-failure latch
before surfacing the bounded UNKNOWN Tool error. The thrown error retains its
cause; no command is republished. Explicit cancellation still bypasses the
infrastructure-unavailable classification. This applies the existing ADR-0151
contract consistently instead of introducing a new recovery policy.

All 30 remote-tool adapter tests pass, including actual Pi Agent execution for
timeout, stopped reply consumer, image decode rejection and mismatched reply.
Each case publishes one Tool command and makes only one model request; user
cancellation is covered separately.
