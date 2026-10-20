# Terminal/preview review characterizations

Baseline: `901da9ed`; deployed runtime remains `model-runtime-058925bb`, schema 192.
These assertions reproduce baseline defects, not repaired acceptance.

```sh
npx tsc -p scripts/experiments/review-terminal-preview-20261020/tsconfig.json
node node_modules/vitest/vitest.mjs run scripts/experiments/review-terminal-preview-20261020/connections.test.ts --maxWorkers=1 --testTimeout=10000 --hookTimeout=10000
```

All HTTP/WebSocket peers listen on loopback and belong to this test process.
The terminal gateway uses its real transport/authentication middleware with a
controlled database port that supplies an owned development environment and
holds a valid redirect lookup. Sandbox control uses a controlled preview backend.
No production PG, VM, model, credentials or external network is contacted.

The handshake case observes an actual 16-second wait; source inspection
establishes that the upstream WebSocket has no configured handshake deadline.
The preview cancellation case preserves the existing 15-second transport deadline.
Neither case proposes a maximum Agent or healthy interactive-session duration.
Every deliberately blocked peer/source is released and closed by the fixture.

The shutdown case begins opening a preview, starts server shutdown, then releases
the pending backend. It observes a late 200 and a live stream while shutdown is
still waiting. It does not claim that server shutdown has already completed.

See the [review report](../../../docs/reports/terminal-preview-review-20261020.md).
