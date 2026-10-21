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
compatibility behavior.

## Parent child-progress slice

Source derives parent identity from the Worker's existing native family and sends
it with child activity. Projector validates both admitted scopes, forwards a
disposable `run.child_activity` to the parent SSE and observes canonical child
termination. Per-child revision keys prevent siblings from overwriting each other;
writer replacement clears old phases. Existing child summary reads now include
the parent Tool and child Turn IDs. The browser coalesces relationship refresh on
discovery, lifecycle change and reconnect; phase updates add no SQL.

Parent cards show task/phase/navigation with invocation details closed. Tool groups
also start collapsed and no longer expand themselves on progress/failure. Native
final state wins over late phase data; unknown freshness is not a task failure.
Only cards with children subscribe to child observations. No child text is copied
into the parent or native context.

The existing Web/observation/recovery transport suite passes 55 tests; 19 real-PG
child/tree checks pass. The focused 14-test transport/child UI repeat covers
siblings, phase freshness, terminal priority and writer handoff. Control Plane,
Worker, Web and runtime-core type checks pass.

## Ordinary control Tool catalog slice

Source implements ADR-0269: execution modules own declarative definitions and
handlers; the management WebSocket delivers full immutable catalog snapshots.
Workers retain the last valid snapshot, wait for an initial catalog before
ordinary Run admission and install generic callbacks into Pi's Registry. Native
subtractive selection and explicit infrastructure extensions preserve existing
file/role grants while admitting new ordinary names on the next prepared request.
Pi itself records changed tool declarations. There is no cache-preserving loading
protocol, extra history table or per-request catalog SQL.

Preview's definition moved out of Worker-owned infrastructure metadata. Generic
dispatch parsing no longer hardcodes ordinary names; current handler admission
and schema checks produce explicit unavailable/invalid-argument results. Pending
handlers keep their captured implementation. Remote hooks are replaced with the
same native phase snapshot as their definitions, preserving intent-before-effect
even when withdrawal races preparation. Native child/workflow adapters remain
fixed; arbitrary guest tools and unsafe shell work are outside this catalog.

A native submission test adds a previously unknown name while waiting for a Tool,
uses it on the next request, withdraws it inside its accepted handler, retains its
successful result and rejects a later call. Unchanged catalogs produce no extra
system history. WebSocket tests cover registration/change/reconnect; Worker
lifecycle, native child management and existing control reconciliation tests pass.
The initial new fixture used a reply sequence across operations instead of the
existing per-operation value; correcting the fixture preserves the production
reply contract. Type checks and the Helm empty-list rendering contract pass.
Ordinary reply admission also preserves the existing 50 KiB/2,000-line control
result budget; oversized completed output produces a bounded error without a
second handler execution. Its focused regression passes.

The maintained live browser driver now has an explicit runtime-capability mode.
Full release gates, matched artifacts/deployment and real provider/browser/Cube
acceptance are the remaining work. No application rollout has occurred yet.
