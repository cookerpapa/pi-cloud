# Network matrix

| Source | Destination | Allowed | Purpose |
| --- | --- | --- | --- |
| Browser | Web/Control Plane | yes | product API and SSE |
| Control Plane | PostgreSQL | yes | product/Run authority |
| Control Plane | Tool Broker | yes | authenticated Workspace terminal proxy |
| Pi Worker | PostgreSQL | yes | queue, Session and lifecycle state |
| Pi Worker | Tool Broker | yes | fenced Tool RPC |
| Pi Worker | provider proxy/model provider | yes | model requests |
| Tool Broker | PostgreSQL | yes | activation and authority state |
| Tool Broker | Cube API | yes | KVM lifecycle |
| Volume gateway | PostgreSQL/RWX Workspace storage | yes | revision/Volume coordination |
| Cube guest | egress proxy | optional | governed public HTTP/HTTPS |
| Cube guest | platform services/internal/metadata | no | no route/credential |
| Cube guest | other Workspace Volumes | no | mount isolation |

The Sandbox default is deny-all. Public mode routes HTTP/HTTPS through the Cube
egress gateway, which blocks loopback, RFC1918, link-local, metadata, Kubernetes
and platform destinations. Allowing public egress does not grant direct access
to the trusted cluster network.

Placing Cube compute nodes on the same physical subnet as company servers does
not change this policy: PiCloud currently gives a guest only the governed egress
proxy `/32`, followed by a deny-all rule. CubeSandbox can prioritize explicit
`allowOut` CIDRs over that deny rule, but PiCloud does not yet expose this to
tenants. An enterprise debugging mode must therefore be an administrator-owned
CIDR/host policy with audit and explicit blast-radius review. It would grant
guest-initiated outbound connections only; it would not make Cube guests
directly reachable from the corporate subnet.

Kubernetes NetworkPolicy must be enforced by the selected CNI. External CIDRs
must be explicit; `0.0.0.0/0` is not a valid trusted-plane escape hatch.
