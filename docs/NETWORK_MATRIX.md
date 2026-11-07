# Network matrix

Required runtime paths are listed below; an unused path is not proof of a
firewall denial. Enforce deployment isolation with the configured networks/CNI.

| Source | Destination | Runtime access / policy | Purpose |
| --- | --- | --- | --- |
| Browser | Web/Session runtime | yes | authenticated product API, history/statements and SSE |
| Session runtime | PostgreSQL | yes | Run admission, projection, scoped reads and binding/control publication |
| Control Plane | PostgreSQL | yes | resource ownership, lifecycle and management admission |
| Pi Worker | PostgreSQL | yes | queue, Session and lifecycle state |
| Pi Worker | Session runtime | yes | boot registration, membership/catalog transport, bound input preparation and observations |
| Pi Worker | Control Plane | yes | new Cube binding/resource activation |
| Pi Worker | Kafka | yes | direct transactional Session publication and consumption of its boot's Tool replies |
| Pi Worker | provider proxy/model provider | yes | model requests |
| Session runtime / Projector | Kafka | yes | ordered seal/control publication and one group for native history, live views and Tool routing |
| Control Plane | Session runtime | yes | PG-authorized control publication; never native appends |
| Session runtime | Cube execution/data endpoints | yes | fixed Tool dispatch, workflow/image/Skill/preview data and retention |
| Control Plane | Cube API | yes | VM lifecycle and resource recovery |
| Cubelet trusted completion adapter | Kafka | yes | native final replies to original Worker boot |
| Cubelet trusted completion adapter | PostgreSQL / private S3 | yes | image inventory and immutable bytes |
| Cubelet trusted completion adapter | Session runtime | yes | disposable progress HTTP observations |
| Volume gateway | PostgreSQL / Workspace storage / quota helper | yes | revision/Volume coordination and initial capacity enforcement |
| CLIProxyAPI / Cubelet / Workspace quota helper | Metering receiver | yes | durable source receipts, independently of management |
| Metering receiver | PostgreSQL | yes | idempotent accounting ledger and immutable price versions |
| Cube guest | egress proxy | optional | governed public HTTP/HTTPS |
| Cube guest | configured company CIDRs | optional | direct debugging/service access |
| Cube guest | other platform services/internal/metadata | no | no route/credential |
| Cube guest | other Workspace Volumes | no | mount isolation |

The Sandbox default is deny-all. Public mode routes HTTP/HTTPS through the Cube
egress gateway, which blocks loopback, RFC1918, link-local, metadata, Kubernetes
and platform destinations. Allowing public egress does not grant direct access
to the trusted cluster network.

Sandbox HTTPS CONNECT has a ten-second establishment deadline and a five-minute
idle deadline refreshed by actual socket traffic. Healthy active tunnels have
no total-duration cutoff. Audit reasons distinguish `connect_timeout` from
`idle_timeout`; this policy is separate from model-provider transport waiting.

Placing Cube compute nodes on the same physical subnet as company servers does
not by itself change this policy. The deployment may set
`PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS`; PiCloud then adds those CIDRs beside
the governed egress proxy in Cube's `allowOut`, ahead of the deny-all fallback.
The rule grants guest-initiated outbound connections only; it does not make Cube
guests directly reachable from the corporate subnet.

Kubernetes NetworkPolicy must be enforced by the selected CNI. External CIDRs
must be explicit; `0.0.0.0/0` is not a valid trusted-plane escape hatch.
