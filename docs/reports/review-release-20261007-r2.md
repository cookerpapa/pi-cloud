# October 7 post-release repair rollout

The owner-authorized matched release deploys the four
[post-release repairs](review-repair-20261007-r2.md). Application/provider and
native Cube images use **review-release-ad2bdd97**, built from
`ad2bdd974afd45e5a8b5ff733c7ccad077231bfc`. The guest identity is
`1d7bbc6072bf974e41d96ec9192e3c787098c6d5`. PostgreSQL remains at schema **182**;
guest input protocol is **4**, native Tool Worker protocol **3**, and managed
Cube protocol **7**. [Release evidence](review-release-20261007-r2.json) records
image provenance, readiness, cleanup and the completed acceptance checks.

Final Helm revisions are PiCloud **28**, infrastructure **27** and Cube **55**.
Both Workers and the serving workloads are ready; publication owns **32/32**
partitions. The deployment/acceptance follow-up source is `8f648019`.

The deployed behavior preserves submission identity across ordinary send/Steer,
allows independent partition progress, reclaims abandoned upload staging under
filesystem locks, and applies EXIF orientation before image conversion. No
compatibility reader, second execution authority or old upload-directory scanner
was introduced. The development-stage destructive-update policy is recorded in
[AGENTS.md](../../AGENTS.md).

## Matched artifacts and deployment repair

The release image audit found that Sharp 0.35.4 needed the published
[0.35.5 security update](https://github.com/lovell/sharp/releases/tag/v0.35.5).
The exact dependency pin and lockfile were updated; 59 Tool Sandbox tests and
its typecheck pass, and all application/native/guest artifacts were rebuilt.
The intermediate `68e4db27` images were never deployed.

All **11** release images pass the repository's zero fixable HIGH/CRITICAL gate.
Raw unfixed findings remain visible. Guest image scanning covers OS packages;
the repository npm audit and dependency SBOM cover its application dependency
closure. The private scan set is `dist/release-evidence-review-release-ad2bdd97`.
The [source verification](review-repair-20261007-r2.md) records the earlier
1,649 workspace tests, 217 fault cases and RF3 checks. The final deployment-helper
suite contains **45 passing tests**; affected-package typechecks and Helm checks
also pass.

A clean native recreation exposed a real deployment defect: the Cube renderer
merged `volumeMounts` by Volume name. The POSIX plugin executable and Cubelet
configuration use the same ConfigMap, so one mount replaced the other. The
renderer now merges mounts by **mountPath**, and the deployment contract requires
both Master/Cubelet plugin executables. The corrected state was applied through
Helm; the mounted and staged executable hashes agree. This deployment/test-only
follow-up does not change the source revision of the already built images.

## Live acceptance

All model-bearing checks use **GPT-6 Luna** and disposable owned resources.

- [Browser retry and concurrent upload](review-release-retry-upload-20261007-r2.json):
  two browser requests resolve to one key/Run after the first successful response
  is deliberately lost. During a paused 1 MiB upload, after 64 KiB has reached
  its real staging file, browsing and another upload finish in about **101 ms**.
  Staging is empty after completion.
- [Elastic Workspace image acceptance](review-release-uploads-20261007-r2.json)
  and [development-machine acceptance](review-release-machine-uploads-20261007-r2.json)
  each upload six files totaling about **60.9 MB**, including a **24.2 MB** PNG.
  Luna reads the image directly; native history stores a **1,766-byte** reference
  record. Read/Bash and physical byte checks pass. Mutating the Workspace image
  preserves the immutable original; a replacement Worker correctly answers a
  previously unasked visual question without Tools.
- [Native Provider acceptance](review-release-native-provider-20261007-r2.json)
  passes both real-VM cases: unconfirmed allocation closure retains the VM and
  quota, and two tenants pass isolation, public/private egress, PTY, warm-process,
  stale-authority, cancellation and physical cleanup checks. Public proxy access
  was enabled only for this fixture and restored to its original disabled,
  unconfigured state. Its temporary configuration changes retain an audit record.

The additional [whole-production gate](review-release-production-gate-20261007-r2.json)
is **not recorded as passing**. Earlier attempts verified coding, preview,
cross-Run warm processes and creation of the 1,024-file fixture. After correcting
its obsolete quota/binding/eviction assumptions, two fresh reruns failed when
the model gateway received HTTP **500** from the model proxy. That observation
does not identify a failure at the model vendor itself. A complete gate rerun,
including cold-VM continuation after exact PG lifecycle reconciliation, remains
pending. The targeted repair acceptance above passed independently; no product
retry, shell replay or weakened assertion was added to turn these failures green.

The live fixtures were reconciled with current contracts: native Kafka broker
aliases live in an ephemeral trusted operator container; browser retry uses Enter
in both idle and running layouts; the deletion fault targets allocation closure;
and the production gate reads unlimited quota policy through the shared parser.
Tool routing rows are observed while active, not queried as retained history.
Physical cold-recovery injection closes the test allocation and waits for its
exact PG lifecycle identity to be released; Worker binding retirement is not a
VM destruction API. These changes remove obsolete test assumptions and do not
relax the corresponding product guarantees.

## Development cleanup

Old uploads and runtime writers were drained before the matched cutover. The
initial reset removed **1,203 rows across 44 business/runtime tables**, six
unreferenced image objects, obsolete/current execution topics and the old
Projector group. Current transport state is recreated from the current release.
Accounts, provider/model configuration and credentials are preserved.

Full native inventory confirmed no VMs on **1/1 nodes** and no Volumes before
native recreation. Seven obsolete dsh-cloud Kubernetes resources and their
undeclared native mounts were removed. Four superseded templates were deleted;
all four current templates are READY. The initial old-image cleanup removed
**410 Docker tags**, **31 K3s image references**, **88 inactive ReplicaSets**,
**30 superseded Helm revision records**, and **six old backup directories**.
Registry cleanup uses the existing Distribution API and its
[offline garbage collector](https://distribution.github.io/distribution/about/garbage-collection/):
259 obsolete manifests were removed and about **1.40 GB** reclaimed. The sole
remaining guest tag retains its complete three-manifest OCI graph and all
33 referenced blobs; each was checked after collection. The registry's normal
deletion-disabled configuration is preserved.

After acceptance, its 136 business/runtime rows, four image objects and nine
temporary tenants were also removed during a second drain. Final checks show
zero Sessions, Runs, Workspaces, live VMs, Volumes or image objects. The original
**29 accounts/tenants and 30 model profiles** remain configured. The current
execution topic/group were recreated normally, without keeping test histories
or old business backups.

The first failed Provider fixture left an attachment reference after the missing
plugin mount. Its immutable allocation was subsequently closed through Cube;
recorded-node absence and managed Volume deletion were confirmed. Only then was
its exact, already deletion-authorized Volume envelope removed. This is scoped
release cleanup, not permission to delete resources on a missing heartbeat.

Single-host acceptance does not establish physical multi-node HA, fleet capacity,
or resolution of the earlier cold-host `SetGuestDateTime` incident. Same-partition
handler serialization remains an architectural limit separate from the repaired
cross-partition progress lock.
