import type { Kysely, ColumnType } from "kysely";
import type { Database } from "../../src/index.ts";

/** Assertions for pre-Durable migrations only. These relations deliberately
 * do not exist in the current runtime's Database interface. */
type HistoricalNative = {
  pi_session_log: {
    tenant_id: string;
    session_id: string;
    seq: ColumnType<string, number | string, number | string>;
    kind: string;
    payload: Record<string, unknown>;
    append_id: string | null;
    id: string | null;
    type: string | null;
    parent_id: string | null;
    lane: string | null;
    custom_type: string | null;
    run_id: string | null;
    operation_kind: string | null;
    timestamp_ms: string | null;
    turn_id: string | null;
  };
};
export const historicalNative = (db: Kysely<Database>): Kysely<HistoricalNative> =>
  db as unknown as Kysely<HistoricalNative>;
