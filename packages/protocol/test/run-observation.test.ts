import { expect, it } from "vitest";
import { parseRunObservation } from "../src/run-observation.ts";

it.each([
  { type: "run.activity", revision: 1, phase: "waiting_model", lastActivityAt: 100 },
  { type: "run.path", sentAt: 100 },
  {
    type: "run.execution",
    revision: 1,
    execution: { status: "not_applicable", stage: "projector", sentAt: 100 },
  },
])("requires an existing safe execution generation for $type", (body) => {
  const value = { ...body, sessionId: "s", turnId: "t", runId: "r", observedAt: 100 };
  expect(parseRunObservation({ ...value, generation: 8 })).toMatchObject({ generation: 8 });
  for (const generation of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      parseRunObservation({ ...value, ...(generation === undefined ? {} : { generation }) }),
    ).toThrow("Invalid Run observation");
});
