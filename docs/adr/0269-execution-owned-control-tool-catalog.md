# ADR-0269: Execution-owned ordinary control Tool catalog

Status: accepted; implementation in progress, not deployed.
Date: 2026-10-21.

## Scope

Implement the ordinary remote-Tool slice of the owner's
[approved plan](../reports/subagent-wait-review-20261021.md). Ordinary trusted
Control Plane tools, starting with preview, own their definition and handler in
one registry. A new name on this existing transport must not require a Worker
build or a new Projector parsing branch. Fixed Pi file/shell tools and native
child/workflow adapters retain their pinned SDK/lifecycle contracts. This is not
arbitrary guest plugin loading or replacement of native child recovery.

## Decision and public boundary

- The Control Plane registry publishes complete `supervisor.tool_catalog`
  snapshots over its existing authenticated Worker WebSocket on registration,
  changes and reconnect. The catalog carries a content revision plus ordinary
  tool names, descriptions, JSON parameter schemas and environment requirements.
  It contains no handlers, credentials, task bodies or provider-specific loading
  items. The registry advertises only registered, enabled implementations.
- Workers validate/cache one catalog. Initial ordinary work admission waits for
  a valid catalog. Existing owners retain their last valid catalog across
  temporary management loss. Ordinary control tools have uniform application to
  Conversations in this slice; existing native role/file grants remain intact.
- A physical Session installs catalog definitions into a separate native Registry
  extension with generic remote callbacks. Pi's `tools: { remove: [...] }`
  selection preserves the fixed denied native capabilities while allowing the
  ordinary extension to change. `GenerationTask.prepare` resolves one immutable
  registry snapshot and records `pi.system` changes before requesting the model.
  Existing requests and admitted callbacks keep their captured definitions.
  This needs no per-change cloud configuration transaction, extra history table,
  per-Step receipt or provider cache protocol. The normal provider request uses
  the full effective tool list.
- Structural control-dispatch decoding accepts bounded tool names; the execution
  registry decides whether an ordinary name is currently available. Missing or
  withdrawn names return a normal bounded unavailable Tool result, rather than
  poisoning a Kafka partition. Known native coordination routes retain their
  existing special recovery checks.
- Withdrawing a tool closes new handler admission and removes future offers.
  An already admitted async handler holds its implementation until it returns.
  Ordinary handlers must be idempotent/reconcilable under the existing operation
  identity because a Projector replacement can revisit their intent. Native
  replay is unsafe by default; arbitrary shell effects remain in Cube.
  Removal never cancels accepted work or deletes its history. Incompatible
  schema/effect/recovery changes still require a drained matched upgrade.
  Ordinary text/details/diagnostics use the existing native control-result
  budget. Invalid or oversized replies settle as bounded errors after execution;
  reply validation must not cause the completed handler to execute again.
- A deployment may restrict enabled ordinary control-tool names. This changes
  catalog availability, not code loading or the fixed SDK tools. It also permits
  a compatible Control Plane restart acceptance while keeping Worker identity.

## Adopt-before-build evidence

Pinned Pi Durable 1.0.0 already supplies Registry install/uninstall, immutable
phase snapshots, subtractive tool selection and positional tool-change entries.
Its ToolTask call handler retains the resolved Tool from validation through
execution/settlement; recovery rechecks both stored and current replay policy.
Use those contracts instead of a second runtime registry/history implementation.
The existing control transport, Kafka intent/reply paths and idempotent handler
reconciliation already provide the cloud boundary. An MCP server/client or
another broker would add a second discovery/execution hop for these code-owned
tools and would not replace native lifecycle adapters. No new framework is
required; the cloud-specific code is a declarative registry and transport adapter.

## Acceptance

- A previously unknown ordinary tool reaches a running native Session without
  rebuilding/reopening its Harness; the next request of the same submission sees
  it. An unchanged catalog produces no additional native system entry.
- Withdrawal removes future offers, lets accepted work finish and returns an
  explicit error for a late unaccepted call. Native file/child grants are unchanged.
- Invalid catalogs retain the last valid view; reconnect installs the current
  snapshot. Revisions and missing implementations cannot create a second writer
  or authorize effect replay.
- Inspect GPT and DeepSeek requests for ordinary full tool declarations. Verify
  parent/child native recovery, management reconnect and the initial matched
  cutover. Cache-hit rate is not a delivery gate.
