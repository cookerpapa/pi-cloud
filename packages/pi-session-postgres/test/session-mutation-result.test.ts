import { expect, it } from "vitest";
import {
  compactPiMutationResult,
  restorePiMutationResult,
} from "../src/session-mutation-result.ts";
import type { PiSessionMutationOperation } from "../src/session-mutation.ts";

it("returns only server stamps and reconstructs the native immutable result without echoing bodies", () => {
  const entry = {
    id: "entry",
    type: "custom" as const,
    customType: "large-body",
    data: { body: "private-content-".repeat(20000) },
  };
  const record = {
    id: "record",
    lane: "main",
    type: "operation_finished" as const,
    runId: "run",
    outcome: "completed" as const,
  };
  const operation: PiSessionMutationOperation = {
    kind: "append_items",
    items: [
      { kind: "append_entry", lane: "main", entry },
      { kind: "append_record", record },
    ],
  };
  const result = {
    items: [
      { ...entry, parentId: null, seq: 3, timestamp: 10 },
      { ...record, seq: 4, timestamp: 11 },
    ],
  };
  const compact = compactPiMutationResult(operation, result);
  expect(JSON.stringify(compact).length).toBeLessThan(250);
  expect(JSON.stringify(compact)).not.toContain("private-content");
  expect(restorePiMutationResult(operation, compact)).toEqual(result);
  expect(() =>
    restorePiMutationResult(operation, {
      format: "append-stamps-v1",
      items: [
        { id: "wrong", seq: 3, timestamp: 10, parentId: null },
        { id: "record", seq: 4, timestamp: 11 },
      ],
    }),
  ).toThrow("identity");
});
