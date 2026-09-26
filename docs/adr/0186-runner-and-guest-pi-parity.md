# ADR-0186: Runner preparation and guest file semantics

Status: accepted for implementation, 2026-09-26.

## Decision and historical boundaries

The owner authorized the Pi-alignment repairs after reviewing their reasons.
Retain ADR-0130/0136's ordinary shared Linux environment, ADR-0166's Cube-free
direct delegation, and ADR-0171's explicit cwd and shared Volume. A cwd is the
base for relative paths, not an additional filesystem isolation boundary inside
the already-isolated guest. Guest file Tools may follow ordinary guest symlinks
and absolute paths. Host-side Volume browsing, mount identity validation and
resource authorization keep their existing containment checks.

Keep native edit/write logic, bounded reads/results, cancellation and credential
handling. Do not load user code or execute project extensions in the Worker.
Automatic project instruction discovery is a separate resource-loading feature:
the review identified its absence, not a regression of an existing contract.
This repair does not implicitly add that feature or force Cube activation for
pure chat.

Use Pi's parallel Tool-batch policy where eligible. Fixed write/edit/bash Tools
remain sequential; read and independent code-owned delegation can use native
parallel execution. Existing Run Tool budgets, Broker capacity, child-tree limits
and fair model permits remain. One physical Session writer still serializes
native publication, and no model permit spans Tool/child waits.

Sampling preparation has one implementation, including the zero-file-Tool case.
Its file-Tool grant must not be confused with the complete Agent Tool registry.
Keep World State capture, Compaction and request identities at their current
durable/clean sampling boundaries; no new state authority is added.

Reconstruct successful Compaction presentation from native Step reason and native
summary/tail. Do not invent a threshold reason on reconnect. Existing native
operation/entry records remain the history authority.

## Acceptance

Test native/guest sibling and symlink access with synthetic files, bounded output,
edit conflicts, interruption, and unchanged host Volume containment. Verify native
read/delegation overlap and sequential mutation batches; retain cold-chat/no-Cube,
World State, retry/Compaction, native publication and cancellation checks.
Compare live/cold Compaction presentation from the same native inputs.
