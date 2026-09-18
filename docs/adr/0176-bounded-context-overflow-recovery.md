# ADR-0176: Bounded native context-overflow recovery

Status: accepted, 2026-09-18, following owner approval of Pi-aligned recovery.

Keep configured context windows and compaction thresholds unchanged. Pi's
character estimate is not an admission guarantee for unseen high-density input.
Adopt the bounded overflow path from pinned Pi's
[AgentSession](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/agent-session.ts),
using its public overflow classifier and Compaction primitives, not a second
tokenizer, summarizer or retry framework.

Only an explicit error from the current provider/model may force one Compaction
and continuation of the failed sampling boundary. Compaction must commit through
the existing native append/ACK path before the next model request. It has a fresh
context-maintenance Step; subsequent sampling captures a new agent Step. This is
not a transport retry of the old frozen context. Successful sampling resets the
bound for a later distinct request; repeated overflow without success ends the
operation. Disabled compaction, cancellation, authority loss or failed summary
must not silently continue or erase history.

Retain accepted input, completed Tool Results and visible interrupted prefixes;
do not append the original user input again, restart the Run or replay Tools.
Use the existing per-Lane operation, append-only Compaction and recovery contract.
A crash still retires the execution through its seal; this does not introduce
transparent Run replay. Other Lanes and provider settings are unchanged.

Expose a safe context-limit terminal reason when recovery cannot finish, not the
raw provider body. Ordinary transient retries keep their existing limits; quota,
authentication and unrelated invalid requests must not trigger compaction.
Output-length recovery and provider-specific exact token counting are not part
of this change. A current input too large to summarize remains an explicit error.

Validate forced compaction below the estimated threshold, one-shot exhaustion,
no duplicate input/effect, Lane separation, canceled/failed summary, authority
loss, durable append failure, cold restore and real unchanged-threshold Luna use.
