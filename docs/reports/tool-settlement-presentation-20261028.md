# Tool settlement presentation

Status: source verified; Web-only publication pending, 2026-10-28.

The owner requested that a failed Tool mark only its own card, rather than the
whole expanded activity group. Remove the group-wide error border and put the
marker on each failed Tool. The collapsed group retains its existing warning
icon. UNKNOWN retains its distinct amber status instead of becoming a red failure.

The existing preview/result boundary already matches the requested behavior.
Temporary Bash output travels over lossy HTTP/SSE and is not Kafka/PG history or
model context. A completed, failed or UNKNOWN Tool unmounts its running preview,
discards the browser's bounded buffer and displays the canonical result. No
observation is promoted into a result; late updates stay ignored. The independent
final-output collector remains unchanged.

Browser acceptance reproduces the old group-wide red border, then verifies the
new marker only on the failed member, including a standalone failed Tool. The same
fixture checks all three settlement outcomes, preview disposal and late-update
rejection. Existing group-only controls, text previews and desktop/mobile width
checks pass. No protocol, persistence or execution policy changes are required.

Existing native Bash contract tests pass for `printf hello`, `true` and `exit 7`:
success with no stdout/stderr returns `(no output)` and `isError:false`; nonzero
exit without output returns `Command exited with code 7` and `isError:true`.
Actual timeout and termination results remain separate from empty successful output.

The current GPT adapter enables `parallel_tool_calls:true`. Pi's default Tool-round
mode is parallel; PiCloud marks Read as parallel and Bash/Write/Edit as sequential.
The pinned Harness serializes the entire batch if it contains a sequential Tool.
That limits execution overlap, not how many calls a model can propose in one response.
The existing integration test again proves two native Reads execute concurrently,
with independently committed execution intents.

A read-only check of the reported conversation confirms that the latest 50 Tool
batches each contain one call. Earlier batches include three Reads in one model
reply. This observation establishes the recent response pattern, not why the model
chose it. No prompt forcing parallel calls or execution-policy change is introduced.

Private evidence: `deploy/production/runtime/release-evidence/tool-settlement-ui-20261028/`.
