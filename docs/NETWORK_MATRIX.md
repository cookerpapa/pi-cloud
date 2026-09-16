# Network matrix

Required runtime paths are listed below; an unused path is not proof of a
firewall denial. Enforce deployment isolation with the configured networks/CNI.

| Source | Destination | Runtime access / policy | Purpose |
| --- | --- | --- | --- |
| Browser | Web/Control Plane | yes | product API and SSE |
| Control Plane | PostgreSQL | yes | product/Run authority |
| Control Plane / Session Projector | Tool Broker | yes | ordered Tool/control delivery, lifecycle and authenticated Terminal/Preview proxy |
| Pi Worker | PostgreSQL | yes | queue, Session and lifecycle state |
| Pi Worker | Control Plane | yes | boot registration, heartbeats and Steer control channel; not Agent output |
| Pi Worker | Tool Broker | yes | binding/lifecycle APIs and read-only Tool-result waits |
| Pi Worker | Kafka | yes | direct accepted-fact, native Session mutation and Tool-command publication |
| Pi Worker | provider proxy/model provider | yes | model requests |
| Tool Broker | PostgreSQL | yes | Workspace runtime ownership and Tool authority state |
| Tool Broker | Kafka | not used | Projector routes positioned commands/seals; Broker does not consume Kafka |
| Control Plane / Session Projector | Kafka | yes | authority-requested seals and one consumer group for native history, live views and Tool routing |
| Tool Broker | Cube API | yes | KVM lifecycle |
| Volume gateway | PostgreSQL/RWX Workspace storage | yes | revision/Volume coordination |
| Cube guest | egress proxy | optional | governed public HTTP/HTTPS |
| Cube guest | configured company CIDRs | optional | direct debugging/service access |
| Cube guest | other platform services/internal/metadata | no | no route/credential |
| Cube guest | other Workspace Volumes | no | mount isolation |

The Sandbox default is deny-all. Public mode routes HTTP/HTTPS through the Cube
egress gateway, which blocks loopback, RFC1918, link-local, metadata, Kubernetes
and platform destinations. Allowing public egress does not grant direct access
to the trusted cluster network.

Placing Cube compute nodes on the same physical subnet as company servers does
not by itself change this policy. The deployment may set
`PI_CLOUD_CUBESANDBOX_DIRECT_PRIVATE_CIDRS`; PiCloud then adds those CIDRs beside
the governed egress proxy in Cube's `allowOut`, ahead of the deny-all fallback.
The rule grants guest-initiated outbound connections only; it does not make Cube
guests directly reachable from the corporate subnet.

Kubernetes NetworkPolicy must be enforced by the selected CNI. External CIDRs
must be explicit; `0.0.0.0/0` is not a valid trusted-plane escape hatch.
