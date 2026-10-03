# Self-hosted K3s cutover — 2026-10-03

Status: cutover and recovery acceptance complete.
Decision: [ADR-0214](../adr/0214-unified-self-hosted-k3s.md).

## Scope and data reset

The owner approved consolidating the mixed Docker/K3s deployment into the existing
K3s cluster, then explicitly replaced data preservation with a clean reset.
Old PiCloud accounts, native conversations, images, Workspace bytes/VMs,
PostgreSQL/Kafka data volumes and business-data backups were deleted. Deployment
configuration, credentials and provider login state were retained. This was a
one-time operator action; normal deployment does not reset data.

The old VM was deleted through Cube and absence confirmed on its recorded node.
Two Workspace volumes had stale master reference counts (4 and 1) after the node
inventory became empty. Only those confirmed-unused records were corrected;
exact-generation deletion markers authorized the existing Volume plugin, then
Cube deleted the volumes. This is not an automatic recovery policy.

All old PiCloud Compose containers/networks and named data volumes were removed,
including the PostgreSQL volume that lacked a Compose project label. Provider
credentials and the shared Cube infrastructure were preserved.

## Resulting deployment

- Existing K3s `v1.36.2+k3s1`, one physical node, namespace `cube-system`.
- `pi-cloud-infrastructure`: PostgreSQL, three Kafka nodes, SeaweedFS,
  CLIProxyAPI and the existing provider egress relay boundary.
- `pi-cloud`: Control Plane/Projector/lifecycle controller, two trusted Workers,
  Web, SSH and Workspace Volume Gateway. Cube already runs in this cluster.
- Selector-backed Services replace manually managed Docker EndpointSlices.
  Cube API and preview traffic use native Services; the two TCP relays are gone.
- Static local PG/Kafka/S3 PVs use node affinity and `Retain`. Cube volumes retain
  their sole Workspace byte-authority role. Worker boot claims persist.
- Local entry points remain 8080, 8081, 8318 and 2222, with separate public/admin
  bind configuration. Docker remains an image builder and isolated-test tool.

The standalone Compose deployment, optional second local K3d cluster, address
bridge generators and obsolete relay implementation/tests were deleted. Install,
status, logs, administration and live verification now use the Linux K3s client.
Distributed Helm deployment with external infrastructure remains available.
Optional monitoring resources also have Kubernetes manifests; they are not enabled
on this deployment and their UIs are not part of the live acceptance below.

Application images were built from `2fe686be74b3` and imported into K3s under
`k3s-2fe686be74b3-murp3v1b`. The matched guest identity is
`57d54b67cc012fff79e32bb99a414a772bf88834`, digest
`sha256:bde09f96d7d1be849031413c1eedc7b1a8622a24b492c4f40efda224710de35a`.
Native log wire v13, Tool wire v2 and schema 165 remain unchanged.

## Failures found during cutover

1. The existing K3s kubelet limited each Pod to 128 tasks. Control Plane's native
   Kafka threads exhausted this budget; HTTP readiness alone still succeeded but
   publication availability was empty and Workers refused admission. The installer
   now uses `pod-max-pids=-1` after the owner requested removal of resource
   ceilings (ADR-0215). Deployment verifies all publication partitions after readiness.
2. Former 1 GiB Worker and 512 MiB provider limits caused OOM kills during large
   image acceptance. Temporary 2 GiB/1 GiB settings proved the cause. The final
   self-hosted profile removes Pod CPU/memory ceilings and the PiCloud Go memory
   override at the owner's request; real physical-memory constraints remain.
4. The K3s local-path PVC helper image was unavailable locally. It is now included
   in the pinned installation prefetch. Docker image imports also normalize
   `docker.io/library` and digest references so CRI finds the imported image.
5. SSH's dependency build ignored the supplied npm registry. It now honors that
   setting and uses the same bounded retry helper as other images.

No failure was repaired by replaying shell commands or changing Pi's agent loop.
The initial OOM/model-error image runs are failed acceptance attempts, not passes.

## Verification

- Both distributed and self-hosted Helm contracts, installer checks, documentation
  links, runtime budgets and all script syntax checks passed.
- All workspace type checks passed. The first default unit invocation hit a
  PGlite socket-reset cascade. Isolated and native-PG reruns passed, followed by
  a clean full `npm test` with both CI PostgreSQL variables.
- Deployment/acceptance helper tests: 53 passed.
- The complete native-PG fault matrix passed all 133 cases. Earlier invocations
  missing the separate conformance database variable were not counted as passes.
- Three real GPT-6 Luna Tool rounds passed: read/write/edit/bash, large output and
  symlink behavior. One timing sample was lost across Worker replacement; it is
  not reported as zero provider latency.
- Four real Luna image turns passed with two 6,294,xxx-byte images and one
  25,128,967-byte image. Kafka carried 778/779-byte references; a cold Worker
  recovered the images and answered an unseen visual ranking correctly.
- PostgreSQL, all three Kafka Pods and S3 were replaced: all five Pod addresses
  changed, Service addresses remained stable, real read/image/bash succeeded,
  and the Cubelet stayed running. The effect marker appeared once.
- A Control Plane SIGKILL during an active Cube Tool preserved Worker identity
  and produced one execution and one correct completion. Acceptance fixtures
  were cleaned; recovery never replayed the shell operation.

## Remaining limits

This proves one-host deployment and process/network recovery, not physical-node
HA or production scale. Local PVs cannot move their bytes to another machine by
changing a Service. Independent-node PG/Kafka/S3 operations still need their own
adopted infrastructure and backup/recovery policy.

New guest templates registered successfully. Cleanup of 27 older template-cache
entries was deferred by Cube's node cleanup RPC timeouts. These deployment caches
are separate from the deleted business volumes; no claim is made that cache GC
completed. Missing health evidence still never authorizes VM destruction.
