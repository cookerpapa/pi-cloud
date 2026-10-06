# Template cleanup after Cubelet address changes

The owner-requested repair is deployed from `59f3db87` under
[ADR-0233](../adr/0233-template-cleanup-node-routing.md).
[Machine-readable evidence](template-cleanup-20261007.json) records the release,
per-template timings, current catalog, storage counts and preserved VM identities.

## Confirmed cause

Template deletion used each replica/job's **recorded Pod IP**, consulting Cube's
node registry only when that field was empty. Rootfs artifact deletion repeated
the same rule. A Cubelet replacement kept its stable node ID and changed its IP,
leaving valid cleanup metadata pointing at an obsolete endpoint.

The oldest failing template recorded `10.42.0.52`; the newest catalog recorded
`10.42.0.218`. The registered Cubelet was already at `10.42.0.6`. TCP checks from
CubeMaster failed for the two recorded addresses and succeeded for the registered
one. A regression test against the unchanged source reproduced a cleanup RPC
sent to the old address despite a newer registry entry.

The database contained 59 replicas across 13 historical addresses for the same
node. Replica/job observations were also deduplicated by `(NodeID, NodeIP)`, so
one node could receive multiple requests to different obsolete endpoints.

## Repair and validation

Patch `0006-template-cleanup-node-routing.patch` changes endpoint selection inside
the pinned CubeMaster. Template/snapshot cleanup and rootfs placement deletion
resolve the stored Node ID through current discovery; historical IPs never route
destructive requests. Cleanup deduplicates by node identity, and target filtering
cannot mistake a reused IP for the original node.

Missing node identity, registration or current address preserves cleanup evidence.
RPC failure/cancellation remains a failure. Active builds, in-use templates,
node-side pins and shared-rootfs reference accounting retain their existing guards.
The public RPC, database schema and VM/Workspace ownership contracts are unchanged.
No template metadata was edited to substitute a new address or fabricate absence.

The template-center suite passes **148 top-level tests**, with **3 optional
upstream Docker/PostgreSQL fixtures skipped**. Five new real-MySQL scenarios cover
shared references, unresolved nodes, RPC failure, node pinning and successful
physical/metadata convergence. Routing tests cover address replacement, duplicate
observations, reused IPs, missing identities and in-use template refusal.
The initial disposable MySQL readiness probe accepted its temporary bootstrap
server; the runner now waits for an actual TCP query against the test database.

`node scripts/check-cube-template-cleanup.mjs` exports the manifest's pinned source
and applies digest-checked patches. CI now explicitly checks out that revision for
native contracts instead of depending on an operator's local Cube checkout. The
test container does not receive a Docker socket. Format, documentation, image
closure and runtime-policy checks pass.

## Deployment and actual cleanup

The three native images use `template-cleanup-59f3db87`, patch-set identity
`5db7e5dcc3f3b829`, completion identity
`b9412dc3af9b5eae8859f0fce56ce4db5b0e1163`. All three actual images pass the
HIGH/CRITICAL scan with zero findings. Managed protocol remains 7 and guest protocol
3. Application images, schema 181 and the existing guest catalog remain unchanged.

Cube metadata and release configuration were privately backed up. Workers and
ingress were drained, and the node inventory showed no live VM before the matched
Cube rollout. After replacement, the node registered at **10.42.0.21**. Cleanup
therefore exercised a further address change, not a one-time metadata rewrite.

Through Cube's normal delete API:

- **55 of 55** selected unused templates were deleted; the catalog went **59 → 4**.
- All four current Agent/development templates stayed **READY** with the same
  image digest and IDs.
- The aggregate CLI deletion time was **42.766 seconds**; median **752 ms**,
  p95 **917 ms**, maximum **1,221 ms**. The complete check took about 46 seconds.
- Rootfs artifact and placement records each ended at **4**, with all remaining
  artifacts READY and no cleanup-pending artifacts.
- CubeMaster's artifact directory allocated usage fell from **44,021,432 KiB** to
  **3,010,740 KiB**, a decrease of **39.11 GiB**. This names the measured directory,
  not total host space or registry-layer garbage collection.

[Real GPT-6 Luna acceptance](template-cleanup-tools-20261007.json) then writes a
file and runs Bash through a fresh Cube, verifies its exact hash, and checks native
Tool persistence. Two complete calls/checkpoints are present and no partial Tool
call entered native documents. Owned test resources are cleaned up; the two
historical UNKNOWN VM identities remain unchanged. No VM quota or Workspace data
was cleared as part of template cleanup.

The release helper retains its 30-second auxiliary I/O budget for genuinely
unavailable nodes. This administrative backlog cleanup used bounded sequential
API requests, outside image registration. Physical multi-node failover and old
Volume-reference reconciliation remain separate unfinished work.
