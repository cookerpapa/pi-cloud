import assert from "node:assert/strict";
import { sql } from "kysely";

/** Observe the serving collector. Never synthesize timestamps, rates or receipts. */
export async function observeLiveServiceMinutes(db, resourceId, until) {
  return until(
    async () => {
      const { rows } = await sql`select payload from resource_metering_events
      where resource_key=${"compute:" + resourceId} order by from_at`.execute(db);
      const receipts = rows
        .map((row) => row.payload)
        .filter((event) => event.basis === "platform_service_minute_v1");
      if (!receipts.length) return false;
      let milliseconds = 0;
      for (const event of receipts) {
        const duration = Date.parse(event.to) - Date.parse(event.from);
        assert.equal(event.quality, "confirmed");
        assert(duration > 0 && duration % 60_000 === 0);
        milliseconds += duration;
      }
      return { resourceId, receipts: receipts.length, minutes: milliseconds / 60_000 };
    },
    "serving service-minute collector",
    240_000,
  );
}
