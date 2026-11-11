import { expect, it } from "vitest";
import { AllocationAdmission } from "../src/allocation-admission.ts";

it("drains an admitted SDK handoff and rejects a late command before native deletion", async () => {
  const gate = new AllocationAdmission(),
    handoff = Promise.withResolvers<void>();
  const events: string[] = [];
  const executing = gate.use("box", async () => {
    events.push("handoff");
    await handoff.promise;
    events.push("accepted");
  });
  const closed = gate.close("box", async () => {
    events.push("deleted");
  });
  await expect(
    gate.use("box", async () => {
      events.push("late");
    }),
  ).rejects.toThrow("closing");
  expect(events).toEqual(["handoff"]);
  handoff.resolve();
  await executing;
  await closed;
  expect(events).toEqual(["handoff", "accepted", "deleted"]);
});

it("unknown deletion keeps command admission closed while only deletion is retried", async () => {
  const gate = new AllocationAdmission();
  await expect(
    gate.close("box", async () => {
      throw new Error("delete ACK lost");
    }),
  ).rejects.toThrow("ACK lost");
  await expect(gate.use("box", async () => {})).rejects.toThrow("closing");
  let confirmations = 0;
  await Promise.all([
    gate.retryClose("box", async () => {
      confirmations++;
    }),
    gate.retryClose("box", async () => {
      confirmations++;
    }),
  ]);
  expect(confirmations).toBe(1);
});
