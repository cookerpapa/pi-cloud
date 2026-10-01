import { expect, it } from "vitest";
import { createExecutionReference } from "@pi-cloud/protocol";
import { createExecutionPublication } from "../src/execution-publication.ts";

it("binds publication identity to the admitted Run and physical Session writer", () => {
  const leaseId = crypto.randomUUID(),
    runId = crypto.randomUUID();
  const input = {
    tenantId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    runId,
    executionReference: createExecutionReference(leaseId, runId, 3),
    piSession: { id: "physical", lane: "child", writerId: leaseId },
    nextEventSeq: 1,
  };
  expect(createExecutionPublication(input).scope).toMatchObject({
    runId,
    leaseId,
    writerId: leaseId,
    fencingToken: 3,
    piSessionId: "physical",
    piSessionLane: "child",
  });
  expect(() => createExecutionPublication({ ...input, runId: crypto.randomUUID() })).toThrow(
    "does not match",
  );
  expect(() =>
    createExecutionPublication({
      ...input,
      piSession: { ...input.piSession, writerId: crypto.randomUUID() },
    }),
  ).toThrow("does not match");
});
