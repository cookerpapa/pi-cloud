# Guest → Cubelet result characterization

Run from the repository root after installing its pinned dependencies:

```bash
node scripts/experiments/review-20261016-guest-result/run.mjs
```

Requires Linux under UID 1000 (the fixed guest owner), Node, Python 3, Go with the module's toolchain, and an upstream
Cube checkout containing the pinned commit at `~/CubeSandbox` (override with
`PI_CLOUD_CUBESANDBOX_REPOSITORY`). No model, live VM, PG or Kafka is contacted.
Only owned temporary files/processes are created; the upstream checkout is exported,
never edited. Every maintained patch digest is checked before application.

These are baseline characterization probes: their passing assertions reproduce
the reviewed defects, and are not proof of repaired behavior.

- Actual guest Bash execution produces small and truncated progress. The real
  patched native parser forwards the small frame and drops the oversized one.
- The actual guest launcher/Tool run through a local raw PTY. Privilege switching
  and cgroup operations are substituted, so the probe needs no root/VM access.
  Withholding only the receipt produces a successful final frame and completes
  local cleanup, followed by exit 1 and a plain error on the protocol terminal.
- Actual patched driver/parser/containerd FIFO I/O consume those captured frames;
  process/task RPCs are substituted. The lost-receipt case drops the result and
  invokes operation-scope cleanup. This proves the decision, not a live VM kill.
- The original native execution suite runs with the race detector before adding
  review probes. The runner records source identities and toolchain in
  `docs/reports/guest-cubelet-result-review-20261016.json` and removes its temporary
  checkout and fixtures even when an assertion fails.
