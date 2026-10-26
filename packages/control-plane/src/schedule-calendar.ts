import { CronDate, CronExpressionParser } from "cron-parser";
import type { ScheduleTiming, ScheduleTimingInput } from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Calendar dependency stays behind this PiCloud-owned adapter. No timers or I/O. */
export function validateScheduleTiming(input: ScheduleTiming): ScheduleTiming {
  try {
    if (input.kind === "once") {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.at))
        throw Error();
      return { kind: "once", at: new CronDate(input.at).toDate().toISOString() };
    }
    if (input.kind !== "cron" || input.expression.trim().split(/\s+/).length !== 5) throw Error();
    new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(new Date());
    const timing = { ...input, expression: input.expression.trim().replace(/\s+/g, " ") };
    // Hash/random schedules need a separate stable seed contract and are not offered.
    if (/[H?]/i.test(timing.expression)) throw Error();
    CronExpressionParser.parse(timing.expression, { tz: timing.timezone }).next();
    return timing;
  } catch {
    throw new ControlPlaneStoreError(
      "invalid_request",
      "Use an explicit ISO timestamp with offset, or a valid five-field cron expression and timezone",
    );
  }
}
export function nextScheduleTime(timing: ScheduleTiming, after: Date): Date {
  if (timing.kind === "once") {
    const value = new Date(timing.at);
    if (value <= after)
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Choose a future time for this one-time schedule",
      );
    return value;
  }
  return CronExpressionParser.parse(timing.expression, { tz: timing.timezone, currentDate: after })
    .next()
    .toDate();
}
/** The most recent occurrence at or before now, bounded by the recorded due time. */
export function latestScheduleTime(timing: ScheduleTiming, due: Date, now: Date): Date {
  if (timing.kind === "once") return due;
  const previous = CronExpressionParser.parse(timing.expression, {
    tz: timing.timezone,
    currentDate: new Date(now.valueOf() + 1),
  })
    .prev()
    .toDate();
  return previous > due ? previous : due;
}

export function resolveScheduleTiming(input: ScheduleTimingInput, now: Date): ScheduleTiming {
  if (input.kind !== "after") return validateScheduleTiming(input);
  const at = new Date(now.valueOf() + input.seconds * 1000);
  if (
    !Number.isSafeInteger(input.seconds) ||
    input.seconds < 1 ||
    !Number.isFinite(at.valueOf()) ||
    at.getUTCFullYear() > 9999
  )
    throw new ControlPlaneStoreError(
      "invalid_request",
      "Relative schedule time is outside the supported date range",
    );
  return { kind: "once", at: at.toISOString() };
}
