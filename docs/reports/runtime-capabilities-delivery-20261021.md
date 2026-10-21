# Runtime capabilities and delegation delivery

Implementation is in progress under ADR-0268. The owner approved all slices in
the [consolidated plan](subagent-wait-review-20261021.md); this is not a completed
matched release or acceptance claim.

## Guest network policy slice

Source sends credential-free network-policy snapshots on Worker registration,
change and reconnect using the existing management WebSocket. The existing
configuration reader also notices changes from another process. Worker retains
the latest revision; Pi's native `cloud-network` section renders policy on model
preparation. No per-model/Tool SQL or copied proxy credentials are introduced.

Control Plane and Supervisor Host type checks pass. Native conversation,
WebSocket and protocol/settings tests pass 34 checks, including a
policy change between requests of the same native submission and unchanged
section deduplication. The settings-observer repeat also passes, covering
cross-process refresh and suppression of unchanged policy notifications.

The serving global egress setting was disabled and had no configured proxy at
revision 6. After successful npm and PyPI HTTPS requests through the current host
proxy, the maintained PlatformRuntimeSettingsService enabled that proxy at
revision 7. The existing Cube egress gateway then returned HTTP 200 for both
registries. This proves the proxy route, not yet a fresh guest execution.
The first operator identity lookup found no password credential and made no
change; the successful mutation used the configured platform operator's existing
API identity. Accounts and credentials were not changed.

Private configuration evidence is in
`deploy/production/runtime/review-evidence/runtime-capabilities-20261021/`.
Acceptance must preserve the deliberately enabled setting, rather than restoring
the old disabled state. Worker policy delivery remains source-only until the
matched release.

## Ultra profile slice

Source adds Ultra to the existing effort picker/catalog and retains the selected
value in Session/Run records and the existing native cloud-run document. One
profile resolver maps Ultra to native/provider Max plus proactive instructions;
other efforts use explicit-request-only instructions while retaining tools.
Pi renders a named delegation section. The previous unconditional encouragement
is removed. Migration 197 expands current thinking-profile constraints after
writer draining; no queue, lease, task or compatibility layer is added.

Native tests observe the same offered subagent tool with different Max/Ultra
instructions and provider Max. Protocol/domain/native lifecycle checks pass
29 tests; a real PostgreSQL test verifies accepted Ultra survives catalog changes
and dispatch with its original Run snapshot. Web, Worker and Runner type checks
and six Web settings/translation tests pass. Initial failures were duplicate
Ultra values in fixtures that already read the updated catalog, plus an obsolete
domain-test runtime field; they are corrected rather than adding runtime
compatibility behavior. Child-card progress, dynamic catalogs and the matched/
live acceptance remain to do.
