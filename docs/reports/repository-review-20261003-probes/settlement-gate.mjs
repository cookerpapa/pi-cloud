// Optional project-verification reminder, isolated from any model/Tool execution.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { PiSettlementGateController } from "../../../packages/sandbox-supervisor/src/pi-settlement-gate.ts";
const gate = new PiSettlementGateController({
  command: "npm test",
  cwd: ".",
  timeoutMs: 120000,
  maximumFollowUps: 1,
});
const emit = (type, rest) => gate.observe({ type, ...rest });
emit("tool_execution_start", {
  toolCallId: "verify",
  toolName: "bash",
  args: { command: "npm test" },
});
emit("tool_execution_end", {
  toolCallId: "verify",
  toolName: "bash",
  isError: false,
  result: { content: [] },
});
emit("tool_execution_start", {
  toolCallId: "later-edit",
  toolName: "edit",
  args: { path: "app.ts", edits: [{ oldText: "1", newText: "2" }] },
});
emit("tool_execution_end", {
  toolCallId: "later-edit",
  toolName: "edit",
  isError: false,
  result: { content: [] },
});
emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
const report = {
  baseline: "4294c759",
  sequence: ["verification succeeded", "later edit succeeded", "assistant stopped"],
  reminderAfterLaterEdit: gate.prepareFollowUp() !== undefined,
};
assert.equal(
  report.reminderAfterLaterEdit,
  false,
  "Observed baseline changed; reevaluate this finding",
);
await writeFile(
  "/tmp/pi-cloud-review-settlement-gate-result.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
