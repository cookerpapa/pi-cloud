import type { Database } from "@pi-cloud/database";
import { parseUserUploads } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { TurnSteerBackendError, type TurnSteerBackend } from "./turn-steer.ts";

function payloadString(payload: Record<string, unknown>, property: string): string {
  const value = payload[property];
  if (typeof value !== "string" || !value) throw new Error("Invalid queued Steer reference");
  return value;
}

/** HTTP delivery only. The pending-input reconciler owns consumption and recovery. */
export class TurnSteeringService {
  readonly #database: Kysely<Database>;
  readonly #backendFactory: ((sandboxId: string) => Promise<TurnSteerBackend>) | undefined;

  constructor(options: {
    database: Kysely<Database>;
    backendFactory?: (sandboxId: string) => Promise<TurnSteerBackend>;
  }) {
    this.#database = options.database;
    this.#backendFactory = options.backendFactory;
  }

  async deliverQueued(controlRequestId: string): Promise<void> {
    const row = await this.#database
      .selectFrom("turn_control_requests as c")
      .innerJoin("runs as source", "source.queued_steer_id", "c.id")
      .innerJoin("turns as input", "input.id", "source.turn_id")
      .selectAll("c")
      .select(["input.input_text as text", "input.input_uploads"])
      .where("c.id", "=", controlRequestId)
      .where("c.kind", "=", "queue")
      .where("c.state", "in", ["pending", "dispatched"])
      .whereRef("source.tenant_id", "=", "c.tenant_id")
      .whereRef("source.session_id", "=", "c.session_id")
      .where("source.state", "=", "queued")
      .executeTakeFirst();
    if (!row) return;
    if (row.payload.action !== "steer" || typeof row.text !== "string")
      throw new Error("Invalid queued Steer reference");
    if (!this.#backendFactory)
      throw new TurnSteerBackendError(
        "steer_transport_unavailable",
        "Steer transport is unavailable",
        true,
      );
    const dispatched = await this.#database
      .updateTable("turn_control_requests")
      .set({ state: "dispatched", dispatched_at: sql`coalesce(dispatched_at,clock_timestamp())` })
      .where("id", "=", row.id)
      .where("tenant_id", "=", row.tenant_id)
      .where("state", "in", ["pending", "dispatched"])
      .returning("id")
      .executeTakeFirst();
    if (!dispatched) return;
    const backend = await this.#backendFactory(payloadString(row.payload, "sandboxId"));
    // An HTTP error is not evidence of non-consumption. The caller retries this
    // stable input identity or waits for a canonical Entry / projected seal.
    await backend.steer({
      controlRequestId: row.id,
      idempotencyKey: row.idempotency_key,
      text: row.text,
      uploads: parseUserUploads(row.input_uploads),
      target: {
        tenantId: row.tenant_id,
        projectId: payloadString(row.payload, "projectId"),
        workspaceId: payloadString(row.payload, "workspaceId"),
        sessionId: row.session_id,
        runId: row.target_run_id,
        turnId: row.turn_id,
      },
    });
    // Delivery only acknowledges the native memory queue. A late reply must
    // never replace consumption or restoration already decided by reconciliation.
    await this.#database
      .updateTable("turn_control_requests")
      .set({ state: "acknowledged", acknowledged_at: sql`clock_timestamp()`, failure_code: null })
      .where("id", "=", row.id)
      .where("tenant_id", "=", row.tenant_id)
      .where("state", "in", ["pending", "dispatched"])
      .execute();
  }
}
