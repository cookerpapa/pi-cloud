import { sql, type RawBuilder } from "kysely";

/** A known capsule addresses the original allocation even when observation is
 * unavailable. A missing capsule is not a failed create or physical absence. */
export function machineCreationPending(alias?: string): RawBuilder<boolean> {
  const ref = (column: string) => sql.ref(alias ? `${alias}.${column}` : column);
  return sql<boolean>`(
    ${ref("state")} in ('requested','provisioning')
    or (${ref("state")} not in ('ready','released')
      and ${ref("runtime_capsule")} is null
      and not (${ref("allocation_closed")} and ${ref("allocation_absent")})))`;
}

/** Logical recovery retains resource occupancy after the old writer is sealed.
 * Physical absence remains a separate prerequisite in the resource controller. */
export function runRetainsResource(alias?: string): RawBuilder<boolean> {
  const ref = (column: string) => sql.ref(alias ? `${alias}.${column}` : column);
  return sql<boolean>`(
    ${ref("state")} not in ('completed','failed','cancelled','timed_out')
    or ${ref("recovery_requested_at")} is not null
    or (${ref("output_seal_id")} is not null and ${ref("output_sealed_at")} is null))`;
}
