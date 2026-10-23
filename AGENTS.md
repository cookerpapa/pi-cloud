# PiCloud collaboration instructions

## Mission

Build a portfolio-quality, cloud-oriented coding-agent runtime around Pi's
public embedded SDK. The project must demonstrate reliable agent
infrastructure, not merely a chat UI or a collection of framework integrations.

## Current development stage

The owner permits destructive matched upgrades and removal of obsolete PiCloud
business data/runtime resources. Do not retain compatibility code or old business
backups solely to support development-era versions. Preserve accounts, model and
provider configuration, and credentials unless their removal is explicitly in
scope. Drain writers and confirm physical cleanup before discarding ownership
records; destructive development updates do not weaken runtime fencing.

The owner authorizes routine deployment after changes pass the required checks.
Complete the maintained matched release and relevant live acceptance without
asking for another rollout confirmation, unless source-only work is requested.
This does not waive writer draining, fencing or preservation of accounts,
configuration and credentials.

## Before changing code

Read these files first:

1. `README.md`
2. `docs/README.md`
3. `docs/ARCHITECTURE.md`
4. `docs/ROADMAP.md`
5. `docs/BACKLOG.md`

Those files and the indexed ADRs describe the maintained architecture. Treat
research and earlier database migrations as historical evidence, not as
current topology. In particular, historical Cell, Temporal and Worker-affinity
names must never be inferred back into the active runtime without confirming
current production code and the current architecture ADR.

Work on one roadmap item or one vertical slice at a time. If a requested change
alters an architectural invariant, storage ownership, security boundary, or
protocol, record the decision under `docs/adr/` before implementation.

## Engineering rules

- Keep Pi-specific runtime events at the trusted runner and fixed guest Tool
  transport boundary; the public API and durable domain model use PiCloud-owned
  schemas. Native Tool final replies become canonical only after Worker Harness
  processing. Observation-only phase/Tool updates use lossy HTTP/SSE, never Kafka,
  PG or context. ADR-0201/0211 permit bounded transport probes on the same Kafka
  Session path and boot-scoped Worker reply transport; they never become native
  history or a second execution authority. Physical health observations are disposable;
  missing probes never authorize destruction, replay or quota release.
  ADR-0272 separately authorizes finite elastic retention: typed keepalive
  intents renew Cubelet's existing allocation journal, and Cubelet owns idle
  expiry. This does not make diagnostic probes a VM-death signal, renew a PG
  execution lease, or permit quota release without confirmed physical absence.
- Run the fixed Pi core only in the trusted Agent Runner, never in the API/control-plane
  process. Route every untrusted file or shell operation to a separate Tool Sandbox.
- Load only code-owned trusted infrastructure tools in the Agent Runner.
  User/project extensions are outside the current product boundary.
- Use Pi's public tool/extension APIs rather than patching its agent loop.
- Incomplete local Tool calls stay in Worker memory at the public Models port
  (ADR-0230). Only complete successful responses expose calls to native storage;
  never strip fields from committed Storage batches to implement this policy.
- Persist commands before acknowledging them.
- Use idempotency keys, leases, and fencing tokens for distributed mutations.
- One physical Pi Session owns one renewable execution lease/epoch and one Worker
  family slot. Child Lanes retain task identity/cancellation, not separate leases.
  Capacity is Worker-local, including pending claims. Under ADR-0229 a logical
  Run/Turn/native submission may resume after ordered old-writer closure and a
  new PG-issued Session lease; there is no RunAttempt. Durable owns continuation,
  and interrupted unsafe Tools are never automatically replayed. The native
  writer identity is the Session lease incarnation, not a task anchor.
  Model-request permits are local, fair and held only through provider completion;
  never reserve the same permit while waiting for a child or Tool.
- Preserve per-Lane task ordering and one physical-Session writer without
  dedicating a process or OS thread to a cold session.
- PostgreSQL is the sole Run/control authority. Active Pi Session writes are
  fully stamped by one physical-Session writer and acknowledged through R=3
  Kafka; PostgreSQL materializes native storage for cold reads and long-term
  history. ADR-0243 stores Inbox/input metadata and Submissions as authoritative
  current values. ADR-0244 keeps native live progress in Kafka and materializes
  PG checkpoints at settlement or ordered writer handoff; outstanding replay
  references protect that suffix across Run anchors. Other native writes retain
  their historical policy. Do not restore per-Step projection receipts or allocate sequence from
  a second active writer. Cold administrative mutations require Session quiescence.
  Bootstrap only the latest Compaction and active suffix, never lifetime JSONL.
- Under ADR-0247 Workers publish directly with one stable transactional producer
  identity per active physical Session. PG authorization is checked before and
  after producer initialization, never per ordinary commit. Root Runs encompass
  native child Conversations; children are not cloud queue rows or separate writers.
  Normal work_finished retires the idle owner after native family settlement.
  Forced closure takes over the same Kafka identity, rechecks its PG intent and
  commits under the current Projector group. A delayed stale initializer must
  fail post-init authorization; affected valid writers recover through one ordered
  Session closure. Never automatically reinitialize/retry an uncertain writer.
  One Session Projector group owns native history, live views and Tool routing.
  Control changes retain the partition publication queue and group transaction
  guard; Worker open/append HTTP and ingress identity caches are removed.
  Do not add another channel lease, separate live/Tool consumer or per-Step receipt.
  Tool executors remain independently authorized external-effect endpoints;
  replaying a projection must never imply replaying arbitrary shell work.
  Projector confirms its monotonic Kafka dispatch commit before issuing a Tool
  command. Rewinding for text reconstruction never reissues committed commands.
  Whole fixed Pi Tools execute in Cube; boot-scoped Kafka replies resolve the
  original Worker's callbacks. No raw-result GET/cache or PG operation ledger.
  Workers/Kafka/PG are trusted private infrastructure; do not reintroduce per-record
  signatures or key management. This does not remove tenant checks or Tool fencing.
  ADR-0212 carries PG-authorized control references through the same Session
  Kafka partition. Tool/probe binding lookups use the partition owner's memory view;
  lifecycle mutations, closure admission and bootstrap retain PG checks. Never
  rely on a delayed Kafka close event alone to revoke external-effect admission.
- Treat the persistent Cube Volume as the sole Workspace byte authority. Do
  not add a second per-Run archive/checkpoint head without measured recovery
  requirements and a new ADR.
  Volume deletion closes attachment admission and reconciles versioned node
  reference state (ADR-0226). Lost allocation replies, zero holder count alone,
  and replaced node metadata never prove safe Volume deletion.
- Do not claim exactly-once semantics for arbitrary shell commands or external side effects.
- Do not run untrusted tools in the control-plane or trusted Agent Runner process.
- Control Plane owns VM lifecycle policy, binding admission, explicit release
  and recovery. ADR-0273 separates durable user intent and verified allocation
  closure from disposable physical observations. A stable development machine
  receives a new allocation UUID only after confirmed old physical absence.
  Under ADR-0272 Cubelet owns finite elastic idle expiry; retain
  no competing Control Plane deadline scanner or warm-cache eviction policy.
  Dedicated machines remain non-expiring. Cubelet owns
  accepted fixed Tool lifetimes and boot/ordered-position fencing (ADR-0219/0221).
  Do not add per-Tool PG Run-lease checks. Chat Stop aborts the Worker Agent and
  sends operation cancellation through the same Session log. Pi Durable owns
  native abort settlement; late physical replies never overwrite it (ADR-0229).
  No cancellation ACK or missing reply proves a physical process stopped.
  Normal cancellation follows the guest Tool's process-group boundary, not whole
  cgroup/VM cleanup. Completed background work is never cancelled retroactively.
  Revoke routing before sealing; abnormal retirement retains its immutable cleanup
  target in the existing control Outbox, with no process-stop receipt table.
  `SandboxProvider` owns Cube mechanics and exposes no native
  SDK or management credentials to the Worker. There is no independent Broker.
  Quota release requires confirmed absence on the recorded node, not a missing
  heartbeat or master route. A normal Tool error never authorizes whole-VM deletion.
- CubeSandbox KVM is the only supported Tool runtime. Adding an alternate
  runtime requires a new current ADR and the same security/recovery acceptance
  suite; it must not enter as a silent fallback.
- Do not mount the Docker socket, host home directory, or long-lived provider
  credentials into an agent sandbox.
- Do not add a second event broker, cache, workflow scheduler or cluster layer
  merely to make the architecture look larger. Kafka, PostgreSQL and Kubernetes
  have bounded current roles; additions require a demonstrated gap and the
  adopt-before-build policy below.
- Pin Pi and other important dependency versions and provide upgrade contract tests.
- Never commit secrets, generated credentials, session transcripts, or user repositories.

## Adopt before build

Infrastructure is not a creativity contest. Before implementing a distributed
queue, workflow engine, scheduler, event store, sandbox runtime, identity
system, policy engine, telemetry pipeline, or storage protocol:

1. Survey actively maintained open-source implementations using official
   documentation, source, releases, license, and failure semantics.
2. Prefer a well-supported project from an established company, standards body,
   or neutral foundation when it satisfies PiCloud's measured requirements.
   Fit, security boundaries, operational cost, and exit strategy matter more
   than GitHub stars or vendor reputation alone.
3. Record build-versus-adopt evidence in a research note or ADR. A custom
   implementation is allowed only when no candidate preserves the required
   invariants, or when integration would create more correctness and
   operational risk than the bounded code being retained.
4. Put adopted infrastructure behind an PiCloud-owned port/adapter, pin its
   version or image digest, add contract and failure tests, and document
   rollback/export. Do not leak a vendor SDK into the public API or core domain.
5. Assign exactly one durable authority to each concern. Never run a framework
   and a home-grown replacement as competing schedulers, workflow histories, or
   checkpoint heads after cutover.
6. Keep large transcripts, tool output, Workspace bytes, credentials, and model
   payloads out of queue rows. PostgreSQL queue records carry bounded command
   references; PostgreSQL SessionStorage and persistent Cube Volumes own the
   corresponding durable data.

## Vibe-coding discipline

The human owner is not expected to hand-write implementation code, but every
change must remain understandable and demonstrable:

1. State the behavior and acceptance criteria before editing.
2. Inspect existing code and tests before choosing an implementation.
3. Implement the smallest complete vertical slice.
4. Add or update automated tests.
5. Run the relevant verification commands.
6. Explain the data flow, failure behavior, and important tradeoffs in plain language.
7. Update `docs/BACKLOG.md` and any affected architecture document.

Avoid generating large placeholder architectures whose components do not yet
communicate end to end.

## Definition of done

A backlog item is complete only when:

- its acceptance criteria pass;
- errors, cancellation, and relevant crash behavior are covered;
- logs do not expose secrets;
- public protocol/schema changes are documented;
- the implementation can be demonstrated from a clean checkout;
- the owner can explain why the design was chosen.
