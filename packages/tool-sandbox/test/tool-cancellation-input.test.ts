import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { toolCancellationInput } from "../src/tool-cancellation-input.ts";

it("delivers split operation-scoped frames to the Tool signal, once", () => {
  const input = new PassThrough(),
    control = toolCancellationInput(input, "operation");
  input.write('{"type":"worker.cancel",');
  expect(control.signal.aborted).toBe(false);
  input.write('"operationId":"operation"}\n');
  expect(control.signal.aborted).toBe(true);
  input.write('{"type":"worker.cancel","operationId":"operation"}\n');
  expect(() => control.check()).not.toThrow();
  control.close();
});
it.each([
  { name: "wrong operation", frame: '{"type":"worker.cancel","operationId":"other"}\n' },
  { name: "oversized frame", frame: "x".repeat(1025) },
])("refuses invalid cancellation transport: $name", ({ frame }) => {
  const input = new PassThrough(),
    control = toolCancellationInput(input, "operation");
  input.write(frame);
  expect(() => control.check()).toThrow("Invalid native Tool");
  control.close();
});
