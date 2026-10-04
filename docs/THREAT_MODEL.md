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

Pi, PostgreSQL access and short-lived Tool/model capabilities remain in the
trusted Worker. CubeSandbox KVM executes `read/write/edit/bash` and receives no
platform credential. Upstream OAuth/API credentials remain in CLIProxyAPI's
private deployment Volume. The Worker has no Cube API credential; sandbox
management and the Cube host completion adapter have no model credential.

### Tenant and stale-Worker isolation

Every product read/write includes tenant ownership. PG issues one immutable
publication scope under the current ExecutionReference. Records are not signed:
trusted Workers publish through the control-plane ingress. Its cached PG-issued
scope closes before ordered seal publication. Projector preserves historical
scope/position checks and commits dispatch before issuing effects. Cube checks
executor boot, operation identity and monotonic partition positions. The control
plane revokes binding eligibility before sealing, without per-Tool lease/fence
SQL or a second channel lease. Normal Stop cancels unfinished Tool process groups
through the ordered operation transport; VM lifecycle is separate. Unconfirmed
operations may continue and remain UNKNOWN when their result is unavailable.

Workers consume their boot's Kafka replies. Control Plane publishes execution
records; the trusted Cubelet host publishes Tool replies. The Tool guest and
browser never receive Kafka connectivity or credentials.
The deployment must restrict Kafka network/ACL access to trusted roles, especially
Projector consumer-group membership used for internal SSE owner discovery.
Compromised trusted Worker/PG credentials or a malicious Kafka producer are
outside this tenant-isolation claim. Scope checks and seals handle stale or failed
trusted processes; they are not cryptographic proof of a record's origin.

### Durable authorities

PostgreSQL owns Runs and canonical Pi Sessions; Kafka owns the bounded
AcceptedFact log; the persistent Cube Volume owns Workspace bytes. Worker and
Gateway caches are rebuildable. There is no competing workflow or checkpoint
head.

Private S3 owns immutable Session image bytes; PG owns their tenant-scoped
inventory and native-log reachability. Cube host completion adapter/Worker/Control Plane receive bucket
credentials, never the Tool guest or browser. References cannot name arbitrary URLs or
paths. Guest-supplied references, cross-tenant lookups, mismatched hashes and
oversized bodies are rejected. The native loop receives decoded images only at
the trusted Tool/SessionStorage adapters. Image decoders run inside Cube.
Chat upload bodies have pre-buffer concurrency and size limits, scoped PG claims
and fresh sandbox-management/Gateway authorization. Workspace writes use confined directory
descriptors, no-follow opens and exclusive publication. The API retains immutable
image sources without decoding them; the admitted Run normalizes sources in Cube
before requesting model capacity. A PG row lock serializes image pinning with GC.
File metadata remains escaped user data, never a system instruction.

## Key threats and controls

| Threat | Control |
| --- | --- |
| shell escapes container boundary | Cube KVM hardware boundary and hardened template |
| Tool guest reads platform secrets | no secret mounts/service account/platform route |
| cross-tenant Workspace access | stable tenant/Workspace Volume identity and control-plane checks |
| browser forges terminal identity | Control Plane derives tenant/Workspace/Session; browser frames carry only input/resize/control |
| user enumerates another user's development environment | every list, lifecycle and Terminal lookup binds tenant plus authenticated owner user; no Cube ID is public |
| terminal and Agent race on user files | explicitly user-managed POSIX concurrency; each external authority remains scoped and cross-tenant mounts stay impossible |
| Agents intentionally share one exclusive environment | independently authorized Tool bindings share the owner's VM; files and processes use user-managed concurrency, while pause/release wait for active bindings and the terminal |
| two Sessions intentionally share one elastic Workspace | independently fenced Tool bindings enter one unprivileged Cube; files, processes and ports use ordinary Linux semantics and are not isolated from each other |
| exclusive owner has root inside its own VM | KVM is the tenant boundary; the guest contains no platform/model/database credentials and the trusted external executor enforces boot/operation/scope admission |
| user invokes or tampers with envd inside their own VM | envd is credential-free tenant-local transport; Cube traffic/envd tokens, operation admission and every cross-resource authority remain outside the VM |
| Control-plane replacement loses, pauses or swaps an exclusive VM | shutdown leaves physical state unchanged; encrypted reconnect capsule plus PostgreSQL owner CAS and Cube physical metadata/runtime identity validation before adoption |
| directory picker exposes another runtime | tenant/user/environment authorization at Control Plane and sandbox management; listing is read from the selected live Cube only |
| stale Worker mutation | PG-issued publication scope, same-partition opening/seal cutoff and Cube boot/closed-scope checks |
| duplicate queue delivery | idempotent input plus transactional single-Run admission |
| ambiguous shell result | `UNKNOWN`; no automatic replay |
| SSRF/data exfiltration to internal network | private access denied except deployment-owned direct CIDRs; public HTTP uses governed egress proxy |
| host-side path/symlink escape | rooted/O_NOFOLLOW trusted Volume operations; guest Tool cwd is a path base inside KVM, not a second isolation boundary |
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
bridges to the same control-plane-admitted envd PTY. Neither path receives
CubeAPI/envd/model credentials.
Terminal output is intentionally not a durable conversation record; Workspace
files and platform audit metadata remain authoritative.

GitHub App installation tokens are minted just in time for trusted provider API
work, not copied into Agent Workspaces. New App onboarding is disabled pending
GitHub user authorization; already-bound integrations retain signed intake.
GitHub Webhooks are accepted only after
constant-time HMAC-SHA256 verification; their delivery ID is persisted before
an Issue can create model work.

GitLab project access tokens are limited to one connected project and encrypted
at rest with a deployment key. They are unsealed only for trusted provider API
calls and are never copied into user execution. A user connects a GitLab/GitHub
Origin by sending a scoped token directly to the selected environment's hidden
`.git-credentials`; PostgreSQL stores no user Code Host token.
Project Webhooks use GitLab's Standard Webhooks HMAC contract, a recent
timestamp and stable message ID; a `/picloud solve` comment additionally
requires Developer-or-higher membership.
Issue claims use PiCloud identity and tenant authorization. Starting a
private-repository Run separately verifies the exact repository through the
selected environment's Code Host token.

## Not guaranteed

- exactly-once arbitrary shell or external side effects;
- confidentiality of credentials that a user installs into an Agent Workspace;
- process/memory/socket survival after Cube destruction;
- historical Workspace rollback without a storage-backend snapshot policy;
- safety from a Cube/KVM/hypervisor escape vulnerability;
- multi-node disaster recovery unless PostgreSQL and Workspace storage
  are deployed and tested for it.
