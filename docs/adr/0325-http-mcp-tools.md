# ADR-0325: HTTP MCP tools behind execution-owned catalogs

Date: 2026-11-14. Status: accepted; implementation in progress. Issue: #40.

## Decision and scope

Use Pi Durable's public Tool/extension APIs for Worker proxies and the independent
`@earendil-works/pi-mcp@1.0.0` client in the ordinary Tool host. The Harness remains
in trusted Workers. MCP does not introduce another Session consumer, result
database, task scheduler, agent configuration product or execution authority.

The first slice supports Streamable HTTP tools with anonymous or Bearer-token
authentication. It does not launch STDIO servers, host user extension code, or
provide interactive OAuth, MCP sampling/tasks, resources/prompts or Codemode.
An independently hosted STDIO-to-HTTP adapter can be a normal HTTP endpoint.
Files remain owned by their actual Workspace/device; registering an endpoint
does not give it access to another machine's paths.

## Upstream adoption

[Pi's MCP client](https://github.com/earendil-works/pi/blob/v1.0.0/packages/mcp/README.md)
provides discovery, calls, notifications, cancellation and HTTP response-stream
resumption independently of the Harness and CLI. The initial real HTTP probe
passes initialization, Bearer authentication, schemas, text/structured results,
tool errors and cancellation; a lost write response produces one physical effect
without a second call. Private evidence is under `.cache/mcp-20261114/`.

The package's declared protocol baseline is 2025-11-25, with its documented older
negotiated versions. This is not a claim of every future MCP feature. Keep one
pinned client behind a platform-owned adapter; record a concrete unmet requirement
before replacing it with the official SDK. Do not implement another MCP stack.

## Connection and catalog authority

PG owns connection identity, tenant/credential owner, explicit personal or
organization audience, endpoint, encrypted credential, enablement and revision.
Tenant owners administer connections; personal credentials are not shared by
default. Current revisions use CAS. Credentials follow the existing authenticated
encryption pattern and a separate key mounted only in API and Tool-host roles.

Retain the deployment-selected `platform` catalog. Add one explicitly scoped MCP
catalog per connection through the existing compacted configuration topic and
publisher. Connection definition generations are separate from code-release
selection. An old executable cannot publish under a new selected release.
Disabled/deleted connections publish withdrawals with monotonically increasing
generations; removing a PG row cannot let a retained Kafka snapshot resurrect it.

Every consumer reconstructs all selected scope watermarks at cold start. The
Worker's model-facing view filters by its accepted Session tenant/actor and the
current connection audience. The first slice exposes MCP tools only to root
Conversations, keeping child delegation from silently widening external account
access. The selected release plus connection scope/generation identify an admitted
implementation. Name mapping cannot collide with built-in Tools or other connections.

Tool-host discovery/reconciliation publishes metadata after validating the current
connection revision. Discovery failure is visible and does not silently select
another endpoint. Tool changes apply at the next model request, not in the middle
of a provider request. Execution still checks current connection eligibility;
the catalog alone is not permission to use a withdrawn credential. These are
business connection checks, not Worker ownership/lease queries.

## Execution and recovery

Validated intent commits through the existing physical-Session Kafka writer.
Projector confirms the dispatch position before forwarding to Tool host. The MCP
client performs the external call once; a confirmed response follows the existing
reply topic and becomes canonical only after Pi Harness settlement.

Capture the original connection/tool identity and absolute reply deadline. A
replacement Worker may reattach to the original reply wait; it must never call
the MCP server again merely to recover. Extend the existing remote-reply metadata
and protection where ordinary control Tools need it, rather than adding another
operation ledger. Pending recovery needs an internal reply-only proxy even if
the tool is no longer offered to new model requests. A missing reply or lost
Projector/Tool-host caller can still settle as UNKNOWN.

Revocation rejects new admission without retargeting accepted calls. Native Stop
and ordered cancellation retain their current settlement semantics; cancellation
does not prove remote effects were undone. Remote read-only annotations alone do
not authorize replay. Result and progress handling preserve existing bounds and
image claim checks; progress is disposable observation, never history, a resource
keepalive or a new deadline. No MCP credential enters Worker prompts or Kafka.

## Delivery

The initial scope/protocol/storage change requires coordinated publication of
actual consumers. Subsequent supported connection configuration and directory
updates require no Worker or Session API restart. MCP client code belongs only to
the execution artifact. Preserve existing accounts, credentials and Workspace
assets; run relevant source/PG/Kafka/model and failure checks serially.

Acceptance covers scoped visibility/admission, cold bootstrap, live directory
changes, credential rotation/withdrawal, original-result recovery, cancellation,
lost responses without repeated effects, and supported text/image result handling.
Interactive OAuth and sandbox-hosted server lifecycle need separate acceptance
before being advertised. The external SDK remains the deferred #41 item.
