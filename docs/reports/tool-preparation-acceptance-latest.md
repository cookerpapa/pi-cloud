# Bash validation and Tool preparation — 2026-09-05

Tested on base `7a5617ac` plus this change's uncommitted working tree. The
rebuilt Web image and both Worker containers were deployed before live testing.
Topology: one WSL host, PostgreSQL, three Kafka brokers and real Cube KVM.

## Behavior

Bash accepts only `command` and optional `timeout`. Pi's original argument
validator rejects unknown top-level keys before Tool intent or execution. A
directory change belongs in `command`, for example `cd /project && npm test`.
Read/write/edit schemas and the two-phase Tool checkpoint remain unchanged.

One existing Kafka-acknowledged preparation event creates a browser row with
the Tool name, animated spinner and elapsed waiting time. Clock updates are
browser-local; no timer events or partial argument JSON are persisted. The
durable timestamp survives a snapshot-first refresh. A validation error replaces
preparation directly, even though no Tool-start/intent event exists.

## Verification

- 197 tests passed across Web UI, sandbox-supervisor and the Cloud runtime suite.
  Coverage includes unknown Bash fields, valid `cd` commands, rejected calls
  without execution intent, preparation replacement, interruption and streaming.
- All workspace TypeScript checks, affected image builds, formatting and
  documentation checks passed.
- The first live browser assertion selected a short write and timed out waiting
  for another clock tick. The coding Run completed, but this was not counted as
  a passing browser check. Both attempts' temporary machines were released.
- The revised [live Snake test](snake-preview-acceptance-latest.json) waits for
  a write that has remained pending for three seconds. Chrome observed the
  spinner and advancing clock, refreshed during generation, recovered the same
  pending call at three seconds, and observed no preparation rows after settlement.
- GPT-5.6 Terra completed 16 Tool calls with 16 preparation boundaries. Native
  assistant usage totaled 21,894 input, 5,902 output and 135,680 cache-read tokens.
  First assistant text was 2,782 ms; full coding Run was 130,389 ms. These are
  single-workload observations, not throughput or latency-percentile claims.
- Authenticated host Preview returned HTTP 200. Chrome verified Snake start,
  movement, pause and reset; the game loop advanced six ticks before pause.

Acceptance conversations were deleted, their development machines released and
screenshots removed. Existing user resources were preserved; shared Kafka and
database audit/retention policies were not reset to erase test records.

## Upstream feedback

A clearly AI-assisted minimal reproduction was posted on the existing
[Pi issue #5904](https://github.com/earendil-works/pi/issues/5904#issuecomment-5548709681).
It asks whether unknown-argument rejection belongs upstream, not for a new
`cwd` parameter. No upstream fix or maintainer approval is claimed.
