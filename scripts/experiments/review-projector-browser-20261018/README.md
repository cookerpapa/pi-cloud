# Projector/browser baseline characterizations

Reviewed runtime: `5e6a381f`, 2026-10-18. See the
[review](../../../docs/reports/projector-browser-review-20261018.md).

```sh
node --import tsx scripts/experiments/review-projector-browser-20261018/probe.ts /tmp/projector-browser-review.json
```

Uses installed pinned dependencies and actual runtime modules with synthetic
records and an in-memory socket. No models, production services or credentials.
Checks same-Run observation revision reset, snapshot/tail overlap, subscriber byte
retention and commentary span count. The assertions characterize this baseline;
replace them with desired-behavior regressions when implementing approved repairs.
They are not an additional production protocol or a CI requirement to retain bugs.
