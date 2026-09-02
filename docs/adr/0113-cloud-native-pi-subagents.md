# ADR-0113: Cloud-native Pi subagents

Status: accepted

## Context

Pi intentionally keeps subagent orchestration outside its core. The official
repository contains an example, while `nicobailon/pi-subagents`—maintained by
the original example contributor—provides the established community contract
for child execution, foreground/background workflows, composition, steer,
resume and bounded capability inheritance. Its profile mechanism is useful for
local personas, but making profile names determine cloud permissions or
Workspace placement would couple prompts to infrastructure policy.

Running that package's local `pi` child processes inside one Agent Host would
bypass PiCloud's PostgreSQL Run queue, make child Session data local to one
Worker and route child Tools outside the fenced Cube boundary. Replacing it
with a new PiCloud-specific model-visible protocol would lose upstream
compatibility and create a second subagent design.

Conversation forks and delegated execution also have different product
semantics. Both are useful visible history, but a subagent child must appear as
a typed execution branch rather than silently masquerading as a normal user
conversation.

## Decision

- Pin and adapt the public `pi-subagents` contract; do not patch Pi's Agent
  Loop or invent a competing agent-profile/workflow language.
- Disable upstream built-in persona profiles. Expose one neutral internal
  `cloud-child` selector only because the upstream runner contract requires an
  agent name. Child behavior comes from its task; context inheritance, allowed
  Tools, Workspace mode, model and thinking are independent explicit inputs.
- Replace only the package's child execution backend. Each child is admitted as
  a durable Child Session and Child Run, then claimed by the existing shared
  Pi Agent Host pool.
- PostgreSQL owns the parent/child execution relation, child Run state and all
  Pi Session entries. A local child process, local JSONL file or Worker cache is
  never authoritative.
- Keep human conversation ancestry separate from `subagent_executions`, then
  project both into the product tree with explicit node types.
- List Child Sessions beneath their causal parent Session and anchor them to
  the parent Turn that invoked the orchestration Tool. A `fork` context edge is
  rendered as inherited context; a `fresh` edge is rendered as independent
  context. Workspace mode is displayed separately because context inheritance
  and file/process sharing are independent decisions.
- Child transcripts are tenant-scoped, durable Pi Sessions that users may
  inspect read-only. Human follow-up, delete and fork operations continue to
  target ordinary conversation Sessions only.
- Freeze the child's Tool set as an intersection with the parent Run
  capability snapshot. A child can never widen its parent's grant.
- Tool capability does not reserve elastic compute. An elastic parent or child
  creates a Cube lazily on its first actual `read`, `write`, `edit` or `bash`
  operation. A Run bound to an existing development machine instead reserves
  its per-Run Tool binding before model sampling, allowing Harness World State
  to distinguish a renewed lease from a physical machine reset.
- Register the same cloud Subagent Tool in eligible Child Runs. Persist
  `root_run_id`, `parent_execution_id` and `depth`, serialize admission under
  the root Run and enforce one deployment-owned budget across the whole tree.
  The maintained defaults are depth 4, 32 total nodes and 3 active descendants;
  deployment configuration may lower or raise them within hard validation
  bounds, but prompts and Tool arguments cannot.
- Fork native Pi context at the boundary before the current delegation prompt.
  This preserves earlier context without copying the parent's “call a
  subagent” request as the Child's own pending instruction. A Child may still
  make a new, concrete delegation through its registered Tool.
- Support explicit Workspace modes:
  - `none`: no Cube Tool access;
  - `shared`: the parent and child use one Workspace runtime with independent
    Tool bindings and ordinary Linux concurrency. A child of a development-
    machine Session inherits that machine identity and working directory;
  - `isolated`: the child receives a Volume fork at a declared parent
    Workspace settlement and uses a different Cube.
- A provider job identity is idempotent across Worker loss. Recovery reattaches
  to the same Child Run and never redispatches the prompt merely because a
  parent Worker disappeared.
- Replace the package's Worker-local supervisor files with a PostgreSQL-backed
  `contact_supervisor`/`subagent_supervisor` channel. Progress is projected into
  the live parent Tool output; blocking decisions are correlated to one Child
  execution and replies resume that existing Run.

## Consequences

- Subagent Runs consume the same Worker capacity as ordinary Runs and can scale
  by adding Agent Host replicas. Their root-tree depth/node/concurrency budget
  remains the bounded orchestration admission rule.
- Worker admission reserves a child lane so waiting parents cannot consume
  every local slot. A future durable parent-wait boundary may reclaim the
  waiting slot as an optimization, but correctness does not depend on it.
- Shared mode preserves live files, dependencies and processes and permits
  user-managed concurrent mutations. Isolated mode requires a
  trusted Volume fork and an explicit result/merge contract. Context mode is
  orthogonal: a trusted worker profile may use either an exact `fork` of the
  parent Pi branch or a `fresh` context in either Workspace mode.
- Project-controlled agent or extension code remains outside the trusted Host.
  The neutral adapter is code-owned and does not load user-defined profiles.
- Parent cancellation is propagated recursively to durable descendant Runs.
  Tree navigation and archival follow the same durable parent-execution links.
- The package's cross-invocation management actions (including standalone
  steer/resume UI)
  remain intentionally unavailable until their local run registry is replaced
  by a PostgreSQL control contract; PiCloud does not pretend local process IDs
  survive Worker replacement.
