import { expect, it } from "vitest";
import { ExecutionPrefix } from "../src/execution-prefix.ts";

it("tracks only identity and monotonic progress through replay and coverage", () => {
  const prefix = new ExecutionPrefix();
  const event = {
    seq: 4,
    eventId: "four",
    get payload(): never {
      throw new Error("Closure progress must not read or retain text");
    },
  };
  prefix.accept(event);
  prefix.accept({ seq: 2, eventId: "two" });
  prefix.accept({ seq: 4, eventId: "four" });
  expect(prefix.highWaterMark).toBe(4);
  expect(prefix.pendingEventIds).toBe(2);
  expect(() => prefix.accept({ seq: 4, eventId: "changed" })).toThrow("Conflicting events");
  prefix.cover(3);
  expect(prefix.pendingEventIds).toBe(1);
  prefix.cover(8);
  prefix.cover(1);
  prefix.accept({ seq: 4, eventId: "covered" });
  expect(prefix.highWaterMark).toBe(8);
  expect(prefix.pendingEventIds).toBe(0);
});
