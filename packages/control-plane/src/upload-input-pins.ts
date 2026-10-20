import type { Database } from "@pi-cloud/database";
import { withDatabaseReadSignal } from "@pi-cloud/database/client";
import {
  readHumanInputMetadataBatch,
  readNativeHumanSubmission,
} from "@pi-cloud/pi-session-postgres/durable";
import { sql, type Kysely, type Transaction } from "kysely";

export type UploadInputPin = {
  id: string;
  piSessionId: string;
  conversationId: number;
  runId: string;
  writerId: string;
  kind: "submit" | "mutate";
  operationId: string;
  fingerprint: string;
};

async function lockUploads(tx: Transaction<Database>, pinId: string) {
  // Same upload-before-pin order as input admission. A concurrent definite
  // refusal must not release another delivery's provisional reference.
  await sql`select id from session_uploads where id in
    (select upload_id from session_upload_pins where pin_id=${pinId}::uuid)
    order by id for update`.execute(tx);
}
async function settle(tx: Transaction<Database>, pinId: string, accepted: boolean) {
  if (accepted)
    await sql`update session_uploads set accepted_at=coalesce(accepted_at,clock_timestamp())
      where id in(select upload_id from session_upload_pins where pin_id=${pinId}::uuid)`.execute(
      tx,
    );
  await sql`delete from session_upload_pins where pin_id=${pinId}::uuid`.execute(tx);
}
export async function settleUploadPins(db: Kysely<Database>, pinId: string, accepted: boolean) {
  await db.transaction().execute(async (tx) => {
    await lockUploads(tx, pinId);
    await settle(tx, pinId, accepted);
  });
}

/** Reachability reconciliation only. Never deliver or reconstruct an input. */
export async function reconcileUploadPins(db: Kysely<Database>, signal?: AbortSignal) {
  return withDatabaseReadSignal(signal, async () => {
    const database = db;
    const hints = await sql<{ pin_id: string }>`select pin_id from session_upload_pins
      where reconcile_after<=clock_timestamp() order by reconcile_after,pin_id limit 32`.execute(
      database,
    );
    for (const id of new Set(hints.rows.map((row) => row.pin_id))) {
      signal?.throwIfAborted();
      await database
        .transaction()
        .setIsolationLevel("repeatable read")
        .execute(async (tx) => {
          await lockUploads(tx, id);
          const { rows } = await sql<{
            tenant_id: string;
            pi_session_id: string;
            conversation_id: string;
            run_id: string;
            writer_id: string;
            kind: "submit" | "mutate";
            operation_id: string;
            fingerprint: string;
          }>`select * from session_upload_pins where pin_id=${id}::uuid for update`.execute(tx);
          const pin = rows[0];
          if (!pin) return;
          const metadata = await readHumanInputMetadataBatch(
            tx,
            { tenantId: pin.tenant_id, sessionId: pin.pi_session_id },
            [{ runId: pin.run_id, conversationId: Number(pin.conversation_id) }],
          );
          const state = metadata.get(pin.run_id);
          const receipt =
            pin.kind === "submit"
              ? state?.inputs[pin.operation_id]
              : state?.receipts[pin.operation_id];
          const accepted =
            receipt?.fingerprint === pin.fingerprint &&
            (pin.kind === "mutate" ||
              (
                await readNativeHumanSubmission(
                  tx,
                  {
                    tenantId: pin.tenant_id,
                    sessionId: pin.pi_session_id,
                    conversationId: Number(pin.conversation_id),
                  },
                  pin.operation_id,
                )
              )?.runId === pin.run_id);
          // Input metadata precedes image preparation and native submit. That
          // preparatory record alone cannot confirm a successfully placed input.
          if (accepted) {
            await settle(tx, id, true);
            return;
          }
          // writer_sealed_at is set by ordered projection, after its native tail.
          // A simultaneous newer projection cannot make an old absent read proof:
          // this whole decision uses one repeatable-read snapshot.
          const sealed = await sql`select 1 from session_leases
          where tenant_id=${pin.tenant_id}::uuid and pi_session_id=${pin.pi_session_id}
            and lease_id=${pin.writer_id}::uuid and writer_sealed_at is not null`.execute(tx);
          if (sealed.rows.length) await settle(tx, id, false);
          else
            await sql`update session_upload_pins set reconcile_after=clock_timestamp()+interval '1 minute'
          where pin_id=${id}::uuid`.execute(tx);
        });
    }
  });
}
