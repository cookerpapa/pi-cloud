# Subagent contracts for context, workspaces and devices

Date: 2026-10-26. Research only; the deployed PiCloud tool schema is unchanged.
The owner requested source-backed comparisons before implementing the proposed
`task / context / workspace` contract. This note evaluates that contract rather
than introducing another harness, scheduler or resource authority.

## Owner clarification after the comparison

The workspace-parameter direction is approved for subsequent implementation.
Device usage/reentrancy is coordinated by Agents themselves. The owner rejected
adding platform occupancy registration, reservation Tools or a device-use
scheduler. Existing target binding and execution transport remain the deployed
boundary; this note's discussion of device access is not a request to add a new
reservation system.

## Conclusion

Keep the proposal: task/context describe collaboration, `workspace` describes
access to the coding workspace, and device control remains a separate explicit
binding. A new child conversation does not imply a new physical execution target.
The reviewed projects support these separations, but none establishes our exact
JSON shape as an industry standard.

The contract fits PiCloud's current one-workspace-plus-device model. Its advantage
is that adding a device need not redefine context inheritance or Linux compute
selection. Its limits remain real: multiple workspaces, child device control,
physical-device handoff and provider provisioning require implementation beyond
parameter names. These are future slices, not capabilities delivered by this note.

## Sources and scope

Public documentation, source and selected issues were read. Upstream code was
not executed and no comparative performance/recovery benchmark was performed.
Pinned shallow source checkouts were inspected without running their setup or
project instructions. The snapshots below have commits on October 25–26, 2026;
these are source snapshots, not claims about the latest stable release.

| Project | Inspected revision | License evidence |
| --- | --- | --- |
| OpenClaw | `bb3df792e23f102adb310561b2b3ba4a797ecc2a` | Root `LICENSE`: MIT |
| OpenHands Software Agent SDK | `ce5716a3c0a955a85bb0cc4dcfaa94d5fefcda50` | Root `LICENSE`: MIT |
| Deep Agents | `f26eb54c9b9f66d2ea7edbb9748413d58744534d` | Root `LICENSE`: MIT |
| Cua, supplementary comparison | `75b0b9267ceaaad5e1b7e84f4a8a818474099af8` | Root `LICENSE.md`: MIT; the inspected persistent access module declares **FSL-1.1-MIT** |

Cua's root license must not be generalized to its device-access implementation.
It is useful design evidence, not a proposed dependency or code-copy source.

### OpenClaw: child context, sandbox policy and node targeting are distinct

The spawn schema has separate context and sandbox-policy fields; its sandbox
values express inheritance/requirements rather than arbitrary device cloning.
Node operations identify an existing node. Cloud placement, where enabled, has
its own explicit profile/OS/machine-class selection and rejects invalid placement
rather than silently falling back to another host.

Sources: [spawn schema](https://github.com/openclaw/openclaw/blob/bb3df792e23f102adb310561b2b3ba4a797ecc2a/src/agents/tools/sessions-spawn-tool.ts),
[spawn reference](https://docs.openclaw.ai/tools/subagents/tool-reference),
[node command surface](https://docs.openclaw.ai/nodes),
[node execution](https://docs.openclaw.ai/nodes/node-exec).

[Issue 91145](https://github.com/openclaw/openclaw/issues/91145) discusses which
agent's sandbox settings a child should receive. It is closed; the closure comment
says target-agent resolution already implements the central behavior without a
new `target` enum. Treat this as evidence of an inheritance-contract discussion,
not as proof of an unresolved current defect or an adopted `sandbox=target` API.

PiCloud inference: explicit resource selection and context inheritance are useful
independent controls. We should not copy OpenClaw's many spawn options or treat
its sandbox enum as equivalent to our compute-lifetime enum.

### OpenHands: a child Agent/conversation can reuse the existing workspace

The task manager creates a child `LocalConversation` with the parent's working
directory while obtaining a separately configured child Agent. The SDK also
provides a Workspace abstraction for execution and files. Creating a child is
therefore not inherently creating another machine. This source path proves
workspace reuse, not a universal contract for phone isolation or every backend.

Sources: [task manager](https://github.com/OpenHands/software-agent-sdk/blob/ce5716a3c0a955a85bb0cc4dcfaa94d5fefcda50/openhands-tools/openhands/tools/task/manager.py#L327),
[workspace interface](https://github.com/OpenHands/software-agent-sdk/blob/ce5716a3c0a955a85bb0cc4dcfaa94d5fefcda50/openhands-sdk/openhands/sdk/workspace/base.py),
[delegation example](https://github.com/OpenHands/software-agent-sdk/blob/ce5716a3c0a955a85bb0cc4dcfaa94d5fefcda50/examples/01_standalone_sdk/25_agent_delegation.py).

PiCloud inference: retain native Conversation creation and resource binding as
separate concerns. There is no reason to replace Pi's public child API to improve
our parameter descriptions.

### Deep Agents: context isolation, tools and backends are separate choices

Subagent configuration distinguishes isolated/forked context from its tool set.
Filesystem backends and execution-capable sandbox backends have distinct
interfaces. Context isolation alone does not specify filesystem isolation.

Sources: [subagent definitions](https://github.com/langchain-ai/deepagents/blob/f26eb54c9b9f66d2ea7edbb9748413d58744534d/libs/deepagents/deepagents/middleware/subagents.py),
[backend protocols](https://github.com/langchain-ai/deepagents/blob/f26eb54c9b9f66d2ea7edbb9748413d58744534d/libs/deepagents/deepagents/backends/protocol.py),
[configuration documentation](https://docs.langchain.com/oss/python/deepagents/subagents).

[Issue 6581](https://github.com/langchain-ai/deepagents/issues/6581), open when
inspected, specifically requests shared parent filesystem/sandbox access for
asynchronous children. It distinguishes the synchronous path, which shares the
backend, from remote/thread-scoped async resources. This is discussion of a gap,
not evidence that all async implementations already provide the feature.

PiCloud inference: document resource-sharing semantics for every delegation path.
Our same-physical-Session native children already have a useful foundation; this
research does not propose adopting graph scheduling.

### Cua: a computer is explicitly granted to a named agent

The persistent access module records an agent-to-machine grant. Its bridge checks
that grant when listing or invoking a machine's tools. Agent creation and computer
access are separate actions; belonging to the same account does not by itself
create that grant.

Sources: [access implementation, FSL-1.1-MIT](https://github.com/trycua/cua/blob/75b0b9267ceaaad5e1b7e84f4a8a818474099af8/libs/cua/crates/cua-spaces-ext/src/persistent/access.rs),
[bridge implementation](https://github.com/trycua/cua/blob/75b0b9267ceaaad5e1b7e84f4a8a818474099af8/libs/cua/crates/cua-spaces-ext/src/persistent/bridge.rs),
[device-access tool reference](https://cua.ai/docs/spaces/reference/agents#computer_access_grant).

PiCloud inference: for future real-phone collaboration, pass an explicit target
identity/control grant. Do not interpret a workspace-compute option as device
cloning. Its approval UX, storage and account model are not requirements for our
private deployment.

## Assessment of the PiCloud proposal

The proposed `workspace` object is cohesive if it continues to mean the coding
workspace. `shared` reuses its compute; `ephemeral` requests independent compute
on the same persistent Volume. Neither creates a separate copy of files, clones
application state, or grants phone control. `context=branch` copies conversation
information and does not change resource grants.

Keep these proposed defaults precise:

- Omitted `workspace`: inherit the caller's existing workspace access and allowed
  file/shell tools; do not manufacture workspace access absent from the caller.
- `workspace: null`: no Linux workspace-dependent tools or compute. Platform and
  provider-hosted tools follow their own existing rules.
- Workspace object: `compute` defaults to `shared`; `cwd` must be an existing
  directory; `tools` is a nonempty subset of the parent's read/write/edit/bash
  grant. Use null to disable workspace access instead of a second empty-list mode.
- Device grants stay explicit and children currently receive none. Future device
  delegation can extend a separate target-binding surface without overloading
  `workspace` or changing task/context meanings.
- Unsupported compute selection or contradictory arguments fail before execution;
  do not silently substitute Cube, another device, shared compute or a new target.

The model's available tools and argument validation must follow the same resolved
capabilities. Describe the supported compute choices explicitly and reject an
unsupported request before execution. Future per-Conversation schema narrowing
must use Pi's public APIs and be contract-tested. Generate the child's environment
summary from resolved resources so inherited parent text cannot describe
capabilities the child does not have.

A point to verify during implementation: current fixed file/shell grants and
catalog tool environment requirements are separate. `workspace: null` must cover
workspace-dependent ordinary tools, such as Preview and image generation, as
well as read/write/edit/bash. Narrowing the four-tool array alone is not sufficient
evidence that every workspace path is disabled. This is an acceptance requirement,
not a claim of a newly reproduced external effect.

The broader execution adapter still has deliberate first-slice limitations:
`targetKind` currently accepts Android, the transport requires screenshot support,
and target replies currently use an Android-named timeout. Extending to another
kind requires reviewing those seams. A cleaner subagent schema alone does not
make arbitrary executors plug-and-play.

## Adoption decision and next validation

Adopt the separation of context, workspace access and device control. Retain Pi,
PG authority, Session Kafka publication and existing resource ports. These
projects do not remove a missing scheduler/storage requirement; importing another
harness would duplicate responsibilities. The bounded change is our own tool
contract, parameter validation and consistent capability/environment resolution.

Before calling that implementation complete, verify:

1. Model schema, parsing and validation agree on missing/null/object workspace,
   defaults, unknown old field names and unsupported compute choices.
2. A child of a phone-bound parent receives no phone tools under either fresh or
   branched context, including after recovery/catalog refresh.
3. Null workspace exposes no workspace-dependent tools and cannot create a Cube
   through an ordinary tool; independent platform tools retain their own policy.
4. Shared/ephemeral paths retain the correct compute identities, shared Volume,
   cwd and cancellation/recovery behavior. Neither provisions a phone.
5. A small real-model evaluation asks for screenshot analysis, independent code
   work and a second-phone task. Inspect its tool choices and resulting resource
   bindings. Source tests alone cannot establish that the descriptions prevent
   model misunderstanding.

Status remains research-only. This note records the recommendation for review;
no runtime behavior or model-facing tool schema changed.
