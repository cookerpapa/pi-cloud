import { it, expect, vi } from "vitest";
import { ToolProgressStore } from "../src/tool-progress.tsx";
import type { ToolProgress } from "@pi-cloud/protocol";
it("keeps only mounted Tool observations, resets on reconnect and discards finished cards", () => {
  const store = new ToolProgressStore(),
    changed = vi.fn();
  const progress: ToolProgress = {
    type: "tool.progress",
    sessionId: "s",
    turnId: "turn",
    toolCallId: "tool",
    operationId: "op",
    revision: 1,
    text: "first",
  };
  store.receive(progress);
  expect(store.get("turn\0tool")).toBeUndefined();
  const unsubscribe = store.subscribe("turn\0tool", changed);
  store.receive(progress);
  store.receive({ ...progress, revision: 2, text: "replacement" });
  store.receive(progress);
  expect(store.get("turn\0tool")?.text).toBe("replacement");
  expect(changed).toHaveBeenCalledTimes(2);
  store.reset();
  expect(store.get("turn\0tool")).toBeUndefined();
  unsubscribe();
  store.receive({ ...progress, revision: 3 });
  expect(store.get("turn\0tool")).toBeUndefined();
});
