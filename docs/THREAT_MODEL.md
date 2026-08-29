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
| terminal and Agent race on user files | explicitly user-managed POSIX concurrency; each external authority remains scoped and cross-tenant mounts stay impossible |
| two Agents contend for one exclusive environment | durable `agent_activation_id` CAS permits one Agent authority; a human terminal is independent |
| exclusive owner has root inside its own VM | KVM is the tenant boundary; the guest contains no platform/model/database credentials and the external Tool Broker still validates every Run fence |
| user invokes or tampers with envd inside their own VM | envd is credential-free tenant-local transport; Cube traffic/envd tokens, operation admission and every cross-resource authority remain outside the VM |
| Broker replacement loses, pauses or swaps an exclusive VM | shutdown leaves physical state unchanged; encrypted reconnect capsule plus PostgreSQL owner CAS and Cube physical metadata/runtime identity validation before adoption |
| directory picker exposes another runtime | tenant/user/environment authorization at Control Plane and Tool Broker; listing is read from the selected live Cube only |
| stale Worker mutation | PostgreSQL authority before Kafka `acks=all` and monotonically increasing execution authority |
| duplicate queue delivery | idempotent command plus transactional RunAttempt claim |
| ambiguous shell result | `UNKNOWN`; no automatic replay |
| SSRF/data exfiltration to internal network | private access denied except deployment-owned direct CIDRs; public HTTP uses governed egress proxy |
| path/symlink escape | rooted/O_NOFOLLOW trusted Volume operations |
| infinite output/process/resource use | byte, timeout, PID, CPU, memory and disk limits |
| browser observes non-durable output | Kafka `acks=all` before Gateway SSE; complete Pi entries remain PostgreSQL canonical state |
| Cube loss | process world reset marker plus same persistent Workspace Volume |
| secret leakage in events | platform protocols do not inject credentials; user/Agent commands can still read and expose Workspace Git credentials, so repository scope is the boundary |

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

GitHub App installation tokens are repository-scoped and minted just in time.
For unattended GitHub execution, a short-lived token is written to the selected
Workspace Git Home rather than PostgreSQL or model context. The Agent can read
and exfiltrate it. GitHub Webhooks are accepted only after
constant-time HMAC-SHA256 verification; their delivery ID is persisted before
an Issue can create model work.

GitLab project access tokens are limited to one connected project and encrypted
at rest with a deployment key. They are unsealed only for trusted provider API
calls and are never copied into user execution. A separate user OAuth+PKCE flow
writes its Git credential directly to the selected Workspace's hidden
`.pi-cloud-home`; PostgreSQL stores only one-use state/verifier rows.
Project Webhooks use GitLab's Standard Webhooks HMAC contract, a recent
timestamp and stable message ID; a `/picloud solve` comment additionally
requires Developer-or-higher membership.
Optional GitLab login uses authorization code, PKCE, nonce and a one-use state.
The login OAuth access token is discarded after resolving the external identity;
repository authorization is a distinct OAuth grant.
Claim and start recheck live project membership through the trusted project
adapter; a human claim is not an Agent execution authority.

## Not guaranteed

- exactly-once arbitrary shell or external side effects;
- confidentiality of credentials that a user installs into an Agent Workspace;
- process/memory/socket survival after Cube destruction;
- historical Workspace rollback without a storage-backend snapshot policy;
- safety from a Cube/KVM/hypervisor escape vulnerability;
- multi-node disaster recovery unless PostgreSQL and Workspace storage
  are deployed and tested for it.
