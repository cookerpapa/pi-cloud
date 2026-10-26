import { describe, it, expect } from "vitest";
import {
  validateScheduleTiming,
  nextScheduleTime,
  latestScheduleTime,
} from "../src/schedule-calendar.ts";
describe("pinned calendar adapter", () => {
  it("normalizes explicit offsets and rejects ambiguous or impossible dates", () => {
    expect(validateScheduleTiming({ kind: "once", at: "2026-10-27T08:00:00+08:00" })).toEqual({
      kind: "once",
      at: "2026-10-27T00:00:00.000Z",
    });
    for (const at of ["2026-10-27T08:00:00", "2026-02-30T08:00:00Z"])
      expect(() => validateScheduleTiming({ kind: "once", at })).toThrow();
  });
  it("uses the named zone across daylight-saving changes", () => {
    const t = validateScheduleTiming({
      kind: "cron",
      expression: "0 8 * * *",
      timezone: "America/New_York",
    });
    expect(nextScheduleTime(t, new Date("2026-03-07T13:00:00Z")).toISOString()).toBe(
      "2026-03-08T12:00:00.000Z",
    );
    expect(nextScheduleTime(t, new Date("2026-10-31T12:00:00Z")).toISOString()).toBe(
      "2026-11-01T13:00:00.000Z",
    );
  });
  it("keeps exact due instants and jumps to the latest missed slot without replaying every minute", () => {
    const t = validateScheduleTiming({ kind: "cron", expression: "* * * * *", timezone: "UTC" });
    expect(
      latestScheduleTime(
        t,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-10-26T08:00:00Z"),
      ).toISOString(),
    ).toBe("2026-10-26T08:00:00.000Z");
    expect(() =>
      validateScheduleTiming({ kind: "cron", expression: "*/5 * * * * *", timezone: "UTC" }),
    ).toThrow();
    expect(() =>
      validateScheduleTiming({ kind: "cron", expression: "* * * * *", timezone: "Not/AZone" }),
    ).toThrow();
  });
});
