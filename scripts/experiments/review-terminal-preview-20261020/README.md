# Terminal/preview review characterizations

Baseline: `901da9ed`; deployed runtime remains `model-runtime-058925bb`, schema 192.
The baseline characterizations are retained in Git. Desired-behavior regressions
are maintained in the ordinary Control Plane test suite.

```sh
node node_modules/vitest/vitest.mjs run packages/control-plane/test/connection-lifetimes.test.ts --maxWorkers=1 --testTimeout=25000
```

All HTTP/WebSocket peers listen on loopback and belong to this test process.
The terminal gateway uses its real transport/authentication middleware with a
controlled database port that supplies an owned development environment and
holds a valid redirect lookup. Sandbox control uses a controlled preview backend.
No production PG, VM, model, credentials or external network is contacted.

The handshake case verifies the actual 15-second connection deadline and retryable
error. The preview cancellation case preserves its 15-second transport deadline.
Neither case proposes a maximum Agent or healthy interactive-session duration.
Every deliberately blocked peer/source is released and closed by the fixture.

The shutdown case begins opening a preview, starts server shutdown, then releases
the pending backend. Shutdown joins the open, disposes the late stream and emits
no successful late CONNECT. Redirect cases also cover rejected validation and
user disconnection while the previous peer closes.

See the [review report](../../../docs/reports/terminal-preview-review-20261020.md).
