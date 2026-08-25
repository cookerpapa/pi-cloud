# Backlog

This backlog covers the current PostgreSQL + Kafka + Pi SDK + Cube persistent-Volume
architecture. Temporal, Cells, MinIO/Kopia and alternate Sandbox runtimes are
retired and remain only in Git history or explicitly superseded ADRs.

## Release verification

- [x] Rename the maintained product and deployment contract to Pi Cloud without
      retaining mixed pre-release runtime identifiers.
- [x] Make the maintained architecture documents explicitly distinguish
      ephemeral RunAttempt ownership from the removed Worker-affinity design,
      and label migrations/discussion logs as historical evidence.
- [x] Make README a concise product/deployment entry, validate local links and
      documented npm commands in CI, and align package-level authority docs.
- [x] Centralize one-host operator settings in the generated private `.env`,
      validate cross-service retention/lease/queue relations, and provide an
      idempotent registered-account administrator command.
- [x] Run strict Helm/value-policy checks before distributed preflight mutates
      a cluster, including placeholder and coupled-budget rejection.
- [x] Keep formatting, typecheck, unit/integration, build, Helm and security
      gates green.
- [ ] Run a clean self-hosted install after every deployment contract change.
- [x] Re-run real-model pure-chat and multi-round coding acceptance after Pi or
      provider changes.
- [x] Exercise the cookie-authenticated browser API surface end to end,
      including Workspace source reads under full Cube capacity, Terminal→Run
      writer handoff, Steer, Cancel/recovery, tree operations and deletion.
- [x] Add a browser-local Chinese/English UI preference while preserving prompts,
      conversation content and Tool/model output byte-for-byte.
- [x] Align the browser transcript with Pi Tool semantics through stable
      presentation rows, grouped Tool activity, dedicated Bash/Read/Write/Edit
      renderers, fenced-code highlighting and reload-stable Compaction/retry
      lifecycle rows.
- [x] Restore a PiCloud sidebar brand and replace the exclusive-machine path
      list with a GNOME-style folder chooser whose authenticated New Folder
      action is fenced against active Agent/terminal ownership.
- [x] Verify Cube destruction followed by attachment of the same persistent
      Workspace Volume to a fresh KVM.

## Reliability

- [ ] Add process-level tests for two Workers racing the same ready command and
      prove one current Attempt/fence produces effects.
- [ ] Prove lost `NOTIFY`, duplicate wakeup and Worker restart do not lose or
      duplicate a Run.
- [x] Stop an unhealthy/disconnected Worker from claiming new PostgreSQL work,
      and keep Runs queued while a human Terminal owns the Workspace writer.
- [ ] Exercise PostgreSQL/PgBouncer failover while direct notification
      connections reconnect.
- [x] Validate transaction-scoped SessionStorage authority through deterministic
      Pi Agent Run, Tool, compaction and interrupted-effect recovery contracts.
- [x] Run Pi 0.84.1's published Session backend conformance suite unchanged
      against the tenant-scoped PostgreSQL `SessionRepo` and retain separate
      authority/isolation contracts.
- [x] Ensure a secondary terminal-projection outage cannot strand a failed Run;
      commit a minimal failure boundary and let later Turns start after it.
- [x] Re-run the production PostgreSQL-native Pi runtime through real model,
      Cube Tool, Workspace settlement and cross-Worker recovery.
- [x] Add bounded human Session-tree projection, inherited transcript reads and
      transactional/idempotent conversation forks.
- [x] Allow a new Workspace terminal to consume its active `pending`
      deployment environment while continuing to reject `failed` versions;
      keep formal validation evidence bound to a fenced Agent Run/Attempt.
- [x] Add recursive conversation-subtree deletion and settled-message tail
      pruning without rewriting Pi's immutable entry history.
- [x] Add user-owned exclusive Cube development environments without exposing
      the cluster WebUI or Cube credentials to tenants.
- [ ] Add branch rename controls to the tree UI.
- [ ] Expand orphan reconciliation for Cube activations and persistent Volumes.
- [x] Publish Kafka hot-event and PostgreSQL complete-message projection evidence.
- [x] Fold settled Accepted-Kafka tails at the terminal cursor so Gateway
      restart memory is bounded by active/hot Sessions rather than history.
- [x] Preserve conversations when their Workspace is deleted and require an
      explicit rebind before later Turns.
- [x] Distinguish a Session Workspace rebind from same-Workspace Cube recovery
      with one compactable, model-visible World State fact.
- [x] Remove the unreachable Tool Worker portable-capture route; current Cube
      settlement uses only the provider checkpoint and persistent-Volume
      revision path.
- [x] Remove the redundant pre-Kafka group-commit scheduler and require a
      Session-keyed mutation projection barrier before cross-Worker reads.
- [x] Keep Kafka batch durability independent from a browser-only progressive
      text reveal so larger acknowledged chunks do not flash into the transcript.
- [x] Compare Kafka, Valkey Streams and NATS JetStream under one Session-keyed
      transport workload, focused replay, process kill and idle-reader fanout;
      retain Kafka until a replicated production-shaped candidate proves the
      same authority/fence boundary with less custom Gateway state.
- [x] Validate a three-node R=3 JetStream candidate with committed RePublish,
      one Core NATS subscription per Gateway, temporary reconnect replay,
      PostgreSQL semantic projection, stale-Fence rejection and 2,000 sustained
      SSE connections; keep it outside production until batched authority and
      PubAck throughput meet the active-Agent event-rate target.
- [x] Let a durably fenced, expired Worker settle its interrupted Run even when
      its dead management endpoint cannot confirm a physical stop.

## Distributed deployment

- [ ] Validate HPA/KEDA and node autoscaling on at least three physical nodes.
- [ ] Validate shared PostgreSQL queue fairness at target tenant concurrency.
- [ ] Validate RWX storage behavior, quotas and failure recovery for the chosen
      production CSI/Volume backend.
- [ ] Record Tool Broker, persistent Volume gateway and Cube compute-node drain
      evidence.

## Security and operations

- [x] Add deployment-owned direct RFC1918 CIDRs for company-network debugging.
- [ ] Add per-tenant egress policy and a searchable network audit trail.
- [ ] Add administrator-owned MCP connections and Session Tool grants on top
      of the Run capability snapshot; never load tenant code in the Pi Host.
- [ ] Add tenant/session hard deletion and PostgreSQL/Volume retention.
- [ ] Add backup/restore coverage for PostgreSQL and Workspace storage as two
      explicit authorities.
- [ ] Define a separate trust policy before enabling user Pi extensions.

## Multi-agent execution

- [x] Map the maintained `pi-subagents` contract to Child Sessions/Runs rather
      than local Pi subprocesses, with one deployment-bounded recursive tree.
- [x] Support Tool-free, `shared_serialized` and isolated Workspace modes
      without equating conversation forks with file forks.
- [x] Implement a trusted persistent-Volume branch for parallel isolated
      mutating children and return their settled patch to the parent.
- [x] Project fresh and fork-context Child Sessions as typed, read-only nodes in
      the conversation list and tree while preserving their distinct execution
      relation.

## Development environments

- [x] Bind each exclusive environment to one tenant user and Workspace.
- [x] Keep Cube credentials and cluster inventory behind Tool Broker.
- [x] Support create, persistent PTY, pause, resume and release while preserving
      Workspace Volume bytes.
- [x] Share one user-owned Cube across several directory-bound conversations
      while preserving Workspace single-writer admission.
- [x] Add private-token HTTP service preview and deployment-owned development
      environment size profiles.
- [x] Hand an exclusive Cube between human Terminal and Agent Run under durable
      single-writer admission instead of allocating a second VM.
- [x] Add one-use SSH tickets and a trusted SSH-to-Tool-Broker PTY gateway.
- [x] Preserve an exclusive Cube across Tool Broker replacement with an
      encrypted reconnect capsule and Cube pause instead of destroy.
- [x] Browse the live exclusive guest filesystem from `/`, including empty
      directories, without depending on a reference Session checkpoint.
- [x] Separate Workspace/environment management from progressive conversation
      creation and expose deployment-owned profiles to elastic Runs.
- [x] Allocate exclusive environments without asking for an elastic Workspace,
      expose CPU/memory/disk selectors and record the Cube guest IP.
- [ ] Add a bounded WebSocket preview tunnel for HMR and application sockets.

## Product expansion rule

Candidate races, Run rewind, Review Bundles and advanced governance were removed
from the current product because they had no user workflow or measured benefit.
A future expansion requires an end-to-end product decision, public contract and
acceptance suite instead of a dormant backend module.
