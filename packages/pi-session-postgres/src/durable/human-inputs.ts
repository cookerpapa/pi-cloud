import { nativeBodyAtRecord } from "./record-body.ts";
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  NATIVE_HUMAN_INPUT_DOCUMENT,
  humanInputQueueRevisionMaterial,
  parseUserUploads,
  type NativeInputItem,
} from "@pi-cloud/protocol";
import type { DocumentRecord, StorageWrite } from "@earendil-works/pi-durable";
import { DurablePostgresProjection, materializeNativeDocument } from "./postgres-projection.ts";
import { documentAddress, type DurableScope } from "./types.ts";

export type StoredHumanInput = {
  idempotencyKey: string;
  fingerprint: string;
  text: string;
  uploads: unknown[];
  acceptedAt: string;
  revision: number;
  cancelled: boolean;
  nativeId: number | null;
};
export type StoredHumanInputs = {
  runId: string;
  inputs: Record<string, StoredHumanInput>;
  order: string[];
  receipts: Record<string, { fingerprint: string }>;
};
type Queue = { items: Array<{ id: number; mode: string }> };
export const emptyHumanInputs = (runId: string): StoredHumanInputs => ({
  runId,
  inputs: {},
  order: [],
  receipts: {},
});
export function nativeHumanQueueRevision(
  inbox: Queue,
  state: Pick<StoredHumanInputs, "inputs">,
): string {
  return createHash("sha256")
    .update(humanInputQueueRevisionMaterial(inbox.items, state.inputs))
    .digest("hex");
}

async function document(
  projection: DurablePostgresProjection,
  conversationId: number,
  kind: string,
  through: number,
  key?: string,
): Promise<Record<string, unknown> | undefined> {
  const records = await projection.scan(
    {
      kind: "document",
      at: "current",
      fields: {
        address: documentAddress({
          kind,
          scope: { kind: "conversation", conversationId: conversationId as never },
          ...(key ? { key } : {}),
        }),
      },
    },
    1,
  );
  const record = records[0]?.value as DocumentRecord | undefined;
  if (!record) return;
  return materializeNativeDocument(record, await projection.revisions(record.id, through)).value;
}

/** Read-only native adapter: no Harness, scheduling or alternate input authority. */
export async function readNativeHumanInputs(
  database: Kysely<Database>,
  scope: DurableScope & { conversationId: number; runId: string },
): Promise<{
  state: StoredHumanInputs;
  items: NativeInputItem[];
  nativeSequence: number;
  revision: string;
}> {
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readNativeHumanInputs(tx, scope));
  const projection = new DurablePostgresProjection(database, scope, undefined, "references");
  const head = await projection.head();
  const metadata = await document(
    projection,
    scope.conversationId,
    NATIVE_HUMAN_INPUT_DOCUMENT,
    head.seq,
    scope.runId,
  );
  const state =
    metadata === undefined
      ? emptyHumanInputs(scope.runId)
      : (metadata as unknown as StoredHumanInputs);
  if (
    state.runId !== scope.runId ||
    !state.inputs ||
    !Array.isArray(state.order) ||
    !state.receipts
  )
    throw new Error("Invalid native human-input metadata");
  const inbox = ((await document(projection, scope.conversationId, "pi.inbox", head.seq)) ?? {
    items: [],
  }) as Queue;
  if (!Array.isArray(inbox.items)) throw new Error("Invalid native pending-input queue");
  const byNative = new Map(
    Object.entries(state.inputs).map(([id, input]) => [input.nativeId, { id, input }]),
  );
  const items: NativeInputItem[] = inbox.items
    .flatMap((item) => {
      const found = byNative.get(item.id);
      if (!found || item.mode === "write") return [];
      return [
        {
          inputId: found.id,
          idempotencyKey: found.input.idempotencyKey,
          text: found.input.text,
          uploads: parseUserUploads(found.input.uploads),
          acceptedAt: found.input.acceptedAt,
          mailboxPosition: 1,
          status: item.mode === "steer" ? ("steering" as const) : ("queued" as const),
        },
      ];
    })
    .map((item, index) => ({ ...item, mailboxPosition: index + 1 }));
  return {
    state,
    items,
    nativeSequence: head.seq,
    revision: nativeHumanQueueRevision(inbox, state),
  };
}

export async function readNativeHumanSubmission(
  database: Kysely<Database>,
  scope: DurableScope & { conversationId: number },
  inputId: string,
) {
  const row = await sql<{ body: string | null; fields: Record<string, string> }>`
    select l.body,r.fields from pi_durable_records r ${nativeBodyAtRecord}
    where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId}
      and r.kind='submission' and r.fields->>'conversation'=${String(scope.conversationId)}
      and r.fields->>'request'=${JSON.stringify(inputId)} limit 1`.execute(database);
  if (!row.rows[0]) return;
  if (row.rows[0].body === null) throw new Error("Native Submission body is missing");
  const value = JSON.parse(row.rows[0].body).value as {
    id: number;
    status: string;
    entry?: number;
    reason?: string;
  };
  return { ...value, runId: row.rows[0].fields.run };
}

export async function readHumanInputOutcomes(
  database: Kysely<Database>,
  scope: DurableScope & { conversationId: number },
  state: StoredHumanInputs,
) {
  const keys = Object.keys(state.inputs);
  if (!keys.length) return new Map<string, { status: string; entry?: number; reason?: string }>();
  const result = await sql<{ body: string | null; request: string }>`
    select l.body,r.fields->>'request' as request from pi_durable_records r
      ${nativeBodyAtRecord}
    where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId}
      and r.kind='submission' and r.fields->>'conversation'=${String(scope.conversationId)}
      and r.fields->>'request'=any(${keys.map((key) => JSON.stringify(key))}::text[])`.execute(
    database,
  );
  return new Map(
    result.rows.map((row) => {
      if (row.body === null) throw new Error("Native Submission body is missing");
      return [
        JSON.parse(row.request) as string,
        JSON.parse(row.body).value as { status: string; entry?: number; reason?: string },
      ] as const;
    }),
  );
}

/** Batch cold presentation reads: one bounded checkpoint/suffix query per physical Session. */
export async function readHumanInputMetadataBatch(
  database: Kysely<Database>,
  scope: DurableScope,
  requests: readonly { runId: string; conversationId: number }[],
): Promise<ReadonlyMap<string, StoredHumanInputs>> {
  if (!requests.length) return new Map();
  const addresses = requests.map((request) =>
    documentAddress({
      kind: NATIVE_HUMAN_INPUT_DOCUMENT,
      scope: { kind: "conversation", conversationId: request.conversationId as never },
      key: request.runId,
    }),
  );
  const rows = await sql<{ body: string | null }>`select c.body
    from pi_durable_records r left join pi_durable_current c using(tenant_id,session_id,id)
    where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId} and r.kind='document'
      and r.retired_seq is null and r.fields->>'address'=any(${addresses}::text[])`.execute(
    database,
  );
  const result = new Map<string, StoredHumanInputs>();
  for (const row of rows.rows) {
    if (row.body === null) throw new Error("Native input metadata is missing");
    const write = JSON.parse(row.body) as Extract<StorageWrite, { type: "document.create" }>;
    if (write.type !== "document.create" || write.content.kind !== "base")
      throw new Error("Invalid current human-input document");
    const state = write.content.value as unknown as StoredHumanInputs;
    if (state.runId !== write.record.key || !state.inputs)
      throw new Error("Human input scope changed");
    result.set(state.runId, state);
  }
  return result;
}
