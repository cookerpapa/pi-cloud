import { sql } from "kysely";

/** Bound the UNION lookup to one indexed position before resolving its shared body.
 * A flat join can choose a whole-history hash join, even for a single native ID. */
export const nativeBodyAtRecord = sql`left join lateral (
  select body from pi_durable_record_bodies b
  where b.tenant_id=r.tenant_id and b.session_id=r.session_id and b.seq=r.seq and b.ordinal=r.ordinal
  limit 1
) l on true`;
