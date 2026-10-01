# Cube execution and control-plane authority acceptance — 2026-10-01

Status: source implementation and isolated acceptance; shared production rollout is not performed.
Companion publication commit: `2462e8b9f0e286161bdfb77611f977473358e92f`.
Decisions: [ADR-0209](../adr/0209-control-plane-publication-and-sandbox-authority.md)
and [ADR-0210](../adr/0210-cube-execution-handoff-and-scoped-stop.md).

## Resulting ownership

- PostgreSQL remains the only Run/Session authority. A Run executes once; a new
  execution creates another Run. No RunAttempt was introduced. Physical Session
  ID remains Kafka's partition key.
- Worker publishes through the control-plane ingress. Ordinary append admission
  uses memory, with Kafka transactional fencing across ingress replacement.
- The existing Control Plane composes sandbox management and Projector dispatch.
  The independent Broker executable/deployment is removed. Terminal, preview,
  uploads, workflows, machine adoption and Volume gateway retain their ports.
- Projector confirms dispatch commit, then hands fixed Tools to Cube. Cube owns
  native process completion, image claim check and original-Worker Kafka replies.
  Worker Pi after-tool processing still owns the canonical result.
- Control Plane owns VM inspection, quarantine, cleanup and quota. Unconfirmed
  stopping closes binding eligibility durably. Every dispatch reads that flag
  with the immutable descriptor in one indexed query, with no Run/lease query.
  Positive lookup on the recorded Cube node is required before releasing quota.

## Real VM and image evidence

[Machine-readable result](cube-execution-native-20261001.json) records all eight
checks passing. A temporary, labelled VM used the production fixed Tool bundles,
Cube's native containerd/agent transport, the new Go execution manager and the
built Cubelet completion adapter. Its host adapter used a disposable RF3 Kafka,
PostgreSQL 17 and SeaweedFS, not production data. No provider request was made.

The isolated driver exposed a loopback-only handoff fixture and addressed the
existing native Cubelet socket only for the owned VM. The fixture substitutes
for the new CubeAPI/Master HTTP forwarding layer; that layer was built and
contract-tested separately. This is not a claim that the shared installed Cube
API/Master or the full production browser topology has been upgraded.

- Fixed native write/edit/read and UID-1000 Bash completed through Kafka.
- A 27,050,893-byte PNG produced a 449-byte Kafka result. S3 retrieval reproduced
  its SHA-256 exactly. The Worker native Agent received decoded content, and its
  after-tool hook produced the canonical Tool Result.
- The submitting process exited after handoff; Cube still completed its command.
- Killing the host completion adapter during execution caused result delivery
  recovery without running the shell command again (one marker write).
- Cancellation stopped an active TERM-ignoring shell and its detached `setsid`
  descendant. A completed background HTTP server in the same VM still replied.
- An old executor boot was rejected. The owned VM was deleted after every run.

Maximum observed handoff time in the final bounded run was 39.8 ms; this is a
single-host functional sample, not a capacity or distributed latency benchmark.
Intermediate fixture runs exposed a startup timing assumption and exhausted the
small disposable S3 volume setting. The fixture now waits for positive process
startup and uses the production storage sizing. Upload failure returned an
explicit image error; it did not insert broken image data into model context.

## Repository and transport gates

The workspace suite ran against real PostgreSQL for its external integration
contracts. Initial failures identified two startup mocks and three old schema/
seal expectations, plus two parallel-test resource timeouts. Updated expectations
match the new ownership boundaries; the sandbox package now bounds test parallelism.
The failed files and changed package were rerun successfully. The Kafka-only
and PG/Kafka integration gates were additionally run with the correct RF3 broker
setting; they are not counted as skipped coverage.

The aggregate across the full run and successful targeted reruns is **1,513
workspace tests passed**, plus **65 acceptance-helper tests**. Two deployed-Cube
provider tests remain disabled because the shared installed backend is still the
old contract; the real isolated native checks above cover the new backend path.
The [fault matrix](cube-execution-faults-20261001.json) passes **109/109** cases.
The added resource-health quarantine assertions are also checked with PostgreSQL.

Other passing gates: all workspace typechecks, application build, browser
presentation checks, installation/Helm/runtime-policy/observability contracts,
Docker dependency closure/context checks, and the high/critical security gate.
The dependency audit retains two existing moderate findings; no high/critical
finding is ignored. Patched Cubelet execution tests pass with Go's race detector;
Master forwarding/anchored-observation tests and all 101 CubeAPI tests pass.
The renamed Volume Gateway image also passes 20 concurrent creates, process
termination before/after identity publication, user-data preservation and unknown
layout rejection. Disposable Kafka/PG/S3 containers, VMs and native FIFOs have been
removed; local build images and acceptance artifacts are retained for review.

The current publication integration measured 12 private HTTP→RF3 commits at
p50 42.7 ms / p95 47.2 ms with **zero append-handler SQL queries**. Startup,
opening, binding lookup, projection and closure retain their respective queries;
this measurement does not imply the whole system avoids PostgreSQL.

## Packaging and rollout boundary

The reproducible build exports upstream Cube commit
`8721dd151971ce3c2966482bbd32904ad98f378e`, verifies the three patch hashes and
builds pinned API/Master/Cubelet images. It does not modify the operator's source
checkout or copy diagnostics into an image. Managed runtime, completion adapter,
Control Plane and guest v2 images were built locally. No image was pushed and no
production migration was applied.

Migration 159 retains bounded binding descriptors through Run deletion until
scope closure, stores physical recovery capsules, removes borrowed-machine
resource duplicates and renames resource ownership tables. It refuses undrained
execution. There is no old execution or guest-protocol fallback.

The existing Cube cluster also hosts dsh-cloud. Its API/Master/compute services
were not restarted or replaced. Follow the matched [upgrade procedure](../PRODUCTION_DEPLOYMENT.md)
with the shared-cluster owner before production cutover. The old control plane
must first drain/seal Runs and release old-contract VMs; preserve their Workspace
Volumes. End-to-end production browser/terminal/upload checks and real independent
node loss remain rollout gates, not claims established by these isolated tests.
