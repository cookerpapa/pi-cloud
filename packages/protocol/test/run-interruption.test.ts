import { expect, it } from "vitest";
import {
  interruptionReasonForFailureCode,
  isRunInterruptionReason,
  runInterruptionMessage,
} from "../src/run-interruption.ts";

it("uses fixed known-cause explanations without reflecting diagnostic strings", () => {
  expect(interruptionReasonForFailureCode("cubesandbox_tool_result_unknown")).toBe(
    "tool_result_unknown",
  );
  expect(interruptionReasonForFailureCode("pi_timeout")).toBe("execution_timeout");
  expect(interruptionReasonForFailureCode("PRIVATE_DIAGNOSTIC_CANARY")).toBeUndefined();
  expect(isRunInterruptionReason("__proto__")).toBe(false);
  const text = runInterruptionMessage("execution_unavailable");
  expect(text).toContain("execution channel or authority was unavailable");
  expect(text).not.toMatch(/VM.*crash|sandbox.*destroy/);
  expect(runInterruptionMessage()).not.toContain("PRIVATE_DIAGNOSTIC_CANARY");
});
