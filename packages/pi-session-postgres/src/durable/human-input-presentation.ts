import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  NATIVE_HUMAN_INPUT_DOCUMENT,
  parseUserUploads,
  MAX_EXECUTION_FACT_BYTES,
} from "@pi-cloud/protocol";
import { documentAddress, type DurableScope } from "./types.ts";
import type { StoredHumanInput } from "./human-inputs.ts";

/** Locate the end of ONE already-serialized JSON object, without decoding or
 * retaining the rest of a Run's current metadata. JSON.parse still validates it.
 * This is a bounded value-boundary scan, not a replacement JSON codec. */
export function firstJsonObject(text: string): unknown {
  if (text[0] !== "{") throw new Error("Input presentation metadata is missing");
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (--depth === 0) return JSON.parse(text.slice(0, i + 1));
    }
  }
  throw new Error("Input presentation exceeds its native record boundary");
}

export function humanPresentationSliceCharacters(entryBytes: number): number {
  // Metadata adds fixed IDs/hashes to the upload descriptions already present
  // in the native input. Reserve generously, within the existing native fact bound.
  return Math.min(MAX_EXECUTION_FACT_BYTES, entryBytes * 16 + 8192);
}

export async function readHumanInputPresentation(
  db: Kysely<Database>,
  scope: DurableScope,
  requests: readonly {
    inputId: string;
    nativeId: string;
    runId: string;
    conversationId: number;
    entryBytes: number;
  }[],
): Promise<ReadonlyMap<string, StoredHumanInput>> {
  if (!requests.length) return new Map();
  const values = requests.map((r) => {
    if (!r.inputId.startsWith("input-") || r.inputId.length > 128)
      throw new Error("Invalid native input identity");
    return {
      ...r,
      address: documentAddress({
        kind: NATIVE_HUMAN_INPUT_DOCUMENT,
        scope: { kind: "conversation", conversationId: r.conversationId as never },
        key: r.runId,
      }),
      key: JSON.stringify(r.inputId) + ":",
      characters: humanPresentationSliceCharacters(r.entryBytes),
    };
  });
  const result = await sql<{ input_id: string; native_id: string; body: string | null }>`
    with requested as (select * from unnest(${values.map((r) => r.inputId)}::text[],${values.map((r) => r.nativeId)}::text[],
      ${values.map((r) => r.address)}::text[],${values.map((r) => r.key)}::text[],${values.map((r) => r.characters)}::int[])
      as p(input_id,native_id,address,key,characters))
    select p.input_id,p.native_id,
      case when strpos(c.body,p.key)>0 then substring(c.body from strpos(c.body,p.key)+length(p.key) for p.characters) else null end as body
    from requested p join pi_durable_records r on r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId}
      and r.kind='document' and r.retired_seq is null and r.fields->>'address'=p.address
    join pi_durable_current c using(tenant_id,session_id,id)`.execute(db);
  const byId = new Map<string, StoredHumanInput>();
  for (const row of result.rows) {
    if (!row.body) throw new Error("Consumed input presentation is missing");
    const value = firstJsonObject(row.body) as StoredHumanInput;
    if (
      typeof value.text !== "string" ||
      !Array.isArray(value.uploads) ||
      (value.nativeId !== null && String(value.nativeId) !== row.native_id)
    )
      throw new Error("Consumed input presentation identity changed");
    parseUserUploads(value.uploads);
    byId.set(row.input_id, value);
  }
  if (byId.size !== requests.length) throw new Error("Consumed input presentation is incomplete");
  return byId;
}
