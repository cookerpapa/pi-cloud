# Architecture consolidation — 2026-09-10

Base revision: `2f57a7f6`. Tests below ran on the consolidation worktree; the
fault runner's revision field records that base HEAD, not a pristine-base result.
No database migration, public protocol change, new service or recovery authority.

## Code boundaries

- `ConversationReader` owns tenant-scoped list/history/inherited-message queries.
  `ControlPlaneStore` retains Run admission and resource mutations. The snapshot,
  display coverage and environment evidence still use one repeatable-read PG
  transaction; public methods and error identity remain unchanged.
- Shared resource mapping and the store error type have independent modules,
  avoiding an import cycle from the reader back to the write-side store.
- `SandboxAdmission` owns one Broker's physical capacity and FIFO waiters. Broker
  retains warm-runtime eviction, lifecycle, leases, operation admission and Cube
  execution. This is not a Session/Workspace lock or a new quota scheduler.
- The two large source files changed from 2,902/2,940 to 2,246/2,836 lines. Logic
  moved into focused modules; this is not a claim of equivalent total-code deletion
  or completion of all possible large-module refactors.

## Confirmed shutdown defect and capacity correction

The new shutdown regression was run against an isolated copy of the original
Broker source. One development machine occupied the only physical slot, while
an elastic Tool operation waited. On shutdown, the old Broker released the
machine's admission slot before closing the wait queue: the waiting command
actually executed and returned a successful Tool result in the simulated Provider.

The corrected Broker closes allocation admission first, rejecting waiters before
machine detachment. The same test passes with exactly one VM creation, one
persistent-machine detach and no pause. The original-source copy was removed.

Recovery may count existing machines above a newly lowered capacity. Releasing
one must not awaken another allocation while usage remains at/above the limit.
An adoption already in flight during close can still be accounted for and released;
it cannot reopen admission or authorize a new VM creation.

These are deterministic Provider/controller tests, not a physical Cube failure
or proof of a Cube-native atomic launch-generation contract.

## Projection failure contracts

New orchestration tests use the real Projector handler/live view with simulated
PG and transport boundaries. They verify:

- rejected publications never reach UI or Tool routing;
- a terminal waits for its PG seal projection before display/result retirement;
- a handler retired during PG work cannot continue downstream delivery;
- lost owner delivery ACK retries the same record without a duplicate live event;
- a pending owner admission does not serialize unrelated partition handlers.

Existing PGlite-backed PostgreSQL statement tests separately cover idempotent native projection,
seal transactions, lost COMMIT replies, prefix recovery and successor ordering.
Existing executor tests cover in-flight effects finishing after seals, raw-result
retirement and no blind replay. These distinct tests are not labelled one live
end-to-end chaos experiment.

## Verification

- Full single-worker Vitest: **761 passed, 3 explicit environment-dependent
  skips**, 133 passing files. After adding the final in-flight-adoption edge case,
  the final Broker/admission suite passed **42 tests**, including that addition.
- Maintained fault gate: **26/26 passed**, including four new projection/admission
  cases. See [machine-readable results](fault-eval-latest.json).
- All-workspace typecheck, formatting, documentation, timeout/retention policy,
  Helm/distributed values and image import-closure checks passed.
- No paid model run or production Cube mutation was performed in this turn.
  Public history/pagination, Fork, inherited Child detail and tenant isolation
  were exercised through the existing HTTP/PGlite tests.

## Documentation and rollout

Removed obsolete Event Ingest token, output-stream lease, standalone Projector
port and old message-endpoint instructions. Corrected historical Broker-consumer
wording. The documentation checker now rejects those retired setup instructions.
Architecture explicitly records process/partition/Lane coupling and unresolved
Cube launch fencing, multi-node HA and intermittent SSE investigation boundaries.

The initial validation did **not redeploy**: the host had about 200 GiB available but only
13.6% free, below the existing deployment guard's 15% minimum. Services were left
running on their previous images. No build-cache/user-data cleanup was performed
without the requested approval, and the guard was not weakened or bypassed.
Tests used temporary databases/providers and cleaned their own temporary resources.

### Approved cleanup and rollout follow-up

After the user's approval, PiCloud build-cache records were identified by their
build descriptions and dependency graph, then removed by explicit cache-ID
selectors on the local `default` builder. This used
[Docker build-cache pruning](https://docs.docker.com/reference/cli/docker/buildx/prune/),
not image, container, Volume or global system pruning. Unattributed cache was
left alone. Container/image/Volume ID inventories were identical before and
after the completed cleanup passes. Removed cache can be regenerated by builds.

WSL filesystem free space rose from about **200.16 GiB (13.57%)** to
**228.62 GiB (15.50%)** before rebuilding. These are filesystem observations,
not a claim that the Windows VHDX file shrank by the same amount.

Only Control Plane and Tool Broker images were rebuilt and explicitly recreated.
Both running image labels identify implementation **`7acfeefd`**; the deployed
`conversation-reader.ts` and `sandbox-admission.ts` hashes matched the checkout.
The existing Cube template/guest revision was retained because this change did
not alter the guest contract. No schema migration or Workspace reset was needed.

There were zero active Runs and zero pending seals immediately before rollout.
The two unchanged Worker containers automatically restarted after control-channel
registration-close rejection during the joint service replacement, then recovered
healthy. This was not a zero-interruption release or an active-Run failover test.

Post-rollout checks: all 16 running services healthy; Web and authenticated
identity/model/conversation/Workspace/development-environment endpoints returned
HTTP 200. The deployed reader also loaded an existing nonempty conversation.
Original totals remained **35 users, 52 Sessions and 48 Workspaces**. The one
pre-existing unknown development machine remained unknown; it was not deleted.
No paid model call or test account/resource was created for this operational check.

After rebuilding and rollout, about **227.25 GiB (15.40%)** remained free, still
above the unchanged deployment guard.
