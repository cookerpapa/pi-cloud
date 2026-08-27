# Threat model

## Scope

PiCloud is a self-hosted multi-tenant Coding Agent for controlled enterprise
or private deployments. Model-generated commands and repository code are
untrusted. Platform operators, trusted Worker images and external durable
services are inside the administrative trust boundary.

It is not claimed as a hostile public-SaaS boundary without additional abuse,
identity recovery, billing and incident-response controls.

## Primary boundaries

### Trusted Agent versus untrusted execution

Pi, model credentials, PostgreSQL access and Tool capabilities remain in the
trusted Worker. CubeSandbox KVM executes `read/write/edit/bash` and receives no
platform credential. The Worker has no Cube API credential; the Tool Broker has
no model credential.

### Tenant and stale-Worker isolation

Every product read/write includes tenant ownership. Tool and Session mutation
boundaries validate the current, unexpired Session lease. Browser event
writers acquire and renew a shorter PostgreSQL ownership lease under that same
lease before Kafka accepts their Facts.
A paused or partitioned old Worker cannot resume useful effects after the
authority replaces or revokes its lease.

### Durable authorities

PostgreSQL owns Runs and canonical Pi Sessions; Kafka owns the bounded
AcceptedFact log; the persistent Cube Volume owns Workspace bytes. Worker and
Gateway caches are rebuildable. There is no competing workflow or checkpoint
head.

## Key threats and controls

| Threat | Control |
| --- | --- |
| shell escapes container boundary | Cube KVM hardware boundary and hardened template |
| Cube reads platform secrets | no secret mounts/service account/platform route |
| cross-tenant Workspace access | stable tenant/Workspace Volume identity and broker checks |
| browser forges terminal identity | Control Plane derives tenant/Workspace/Session; browser frames carry only input/resize/control |
| user enumerates another user's development environment | every list, lifecycle and Terminal lookup binds tenant plus authenticated owner user; no Cube ID is public |
| terminal races an Agent writer | PostgreSQL-backed human-terminal lease and shared Workspace writer exclusion |
| exclusive environment races an Agent writer | durable `terminal_active`/`agent_activation_id` CAS plus Tool Broker authority handoff |
| exclusive owner has root inside its own VM | KVM is the tenant boundary; the guest contains no platform/model/database credentials and the external Tool Broker still validates every Run fence |
| user invokes or tampers with envd inside their own VM | envd is credential-free tenant-local transport; Cube traffic/envd tokens, operation admission and every cross-resource authority remain outside the VM |
| Broker replacement loses or swaps an exclusive VM | encrypted reconnect capsule plus PostgreSQL owner CAS and Cube physical metadata/runtime identity validation before adoption |
| directory picker exposes another runtime | tenant/user/environment authorization at Control Plane and Tool Broker; listing is read from the selected live Cube only |
| stale Worker mutation | PostgreSQL authority before Kafka `acks=all` and monotonically increasing execution authority |
| duplicate queue delivery | idempotent command plus transactional RunAttempt claim |
| ambiguous shell result | `UNKNOWN`; no automatic replay |
| SSRF/data exfiltration to internal network | private access denied except deployment-owned direct CIDRs; public HTTP uses governed egress proxy |
| path/symlink escape | rooted/O_NOFOLLOW trusted Volume operations |
| infinite output/process/resource use | byte, timeout, PID, CPU, memory and disk limits |
| browser observes non-durable output | Kafka `acks=all` before Gateway SSE; complete Pi entries remain PostgreSQL canonical state |
| Cube loss | process world reset marker plus same persistent Workspace Volume |
| secret leakage in events | bounded schemas and redaction; credentials never enter model context |

Public network mode can still upload the current tenant's code to public
destinations. KVM isolation protects the platform and other tenants; it is not
a data-loss-prevention system. Enterprise deployments should add explicit
destination allowlists and audit.

Workspace terminal access does not expose Cube envd credentials or Sandbox port
22. The browser path uses the logged-in user's tenant role and bounded WebSocket
frames. Standard SSH terminates at a trusted gateway using a one-use,
short-lived password whose hash is consumed atomically from PostgreSQL; it then
bridges to the same Broker-admitted envd PTY. Neither path receives
CubeAPI/envd/model credentials.
Terminal output is intentionally not a durable conversation record; Workspace
files and platform audit metadata remain authoritative.

## Not guaranteed

- exactly-once arbitrary shell or external side effects;
- process/memory/socket survival after Cube destruction;
- historical Workspace rollback without a storage-backend snapshot policy;
- safety from a Cube/KVM/hypervisor escape vulnerability;
- multi-node disaster recovery unless PostgreSQL and Workspace storage
  are deployed and tested for it.
