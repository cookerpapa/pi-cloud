import { sql } from "kysely";
import { IMAGE_OPAQUE_FIELDS } from "../../packages/protocol/src/image-attachment.ts";

/** Acceptance-only reader. Native JSON stays text until parsed by JavaScript,
 * so NUL/surrogate data is never forced through PostgreSQL jsonb. */
export async function nativeHistory(database, { sessionId, tenantId, runId, turnId }) {
  const rows = await sql`select r.tenant_id,r.session_id,r.id,r.seq,r.fields,l.body
    from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
    where r.kind='entry'
      ${sessionId ? sql`and r.session_id=${sessionId}` : sql``}
      ${tenantId ? sql`and r.tenant_id=${tenantId}::uuid` : sql``}
      ${runId ? sql`and r.fields->>'run'=${runId}` : sql``}
      ${turnId ? sql`and r.fields->>'turn'=${turnId}` : sql``}
    order by r.id`.execute(database);
  return rows.rows.map((row) => ({ ...row, entry: JSON.parse(row.body).value }));
}
export function imageReferences(value) {
  const found = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value.type === "pi_cloud_image_v1") {
      found.set(value.attachment.id, value.attachment);
      return;
    }
    for (const [key, child] of Object.entries(value))
      if (!IMAGE_OPAQUE_FIELDS.has(key)) visit(child);
  };
  visit(value);
  return [...found.values()];
}

const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
/** Same bounded, test-scoped evidence through kubectl/psql. JSON bodies are
 * encoded as strings by PostgreSQL and decoded only by JavaScript. */
export async function readNativeHistory(psql, scope) {
  if (!Object.values(scope).some(Boolean)) throw new Error("Native evidence needs a scope");
  const where = ["r.kind='entry'"];
  if (scope.tenantId) where.push(`r.tenant_id=${quote(scope.tenantId)}::uuid`);
  if (scope.sessionId) where.push(`r.session_id=${quote(scope.sessionId)}`);
  if (scope.runId) where.push(`r.fields->>'run'=${quote(scope.runId)}`);
  if (scope.turnId) where.push(`r.fields->>'turn'=${quote(scope.turnId)}`);
  const rows = JSON.parse(
    await psql(`select coalesce(json_agg(json_build_object('body',l.body,'fields',r.fields,'committedAt',c.committed_at) order by r.id),'[]')
    from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
    join pi_durable_commits c using(tenant_id,session_id,seq) where ${where.join(" and ")}`),
  );
  return rows.map((row) => ({ ...row, entry: JSON.parse(row.body).value }));
}
export const nativeMessages = (rows) => rows.flatMap((row) => row.entry.model ?? []);
export function nativeUsage(rows) {
  return nativeMessages(rows)
    .filter((message) => message.role === "assistant" && message.usage)
    .reduce(
      (total, message) => {
        total.requests++;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"])
          total[key] += message.usage[key] ?? 0;
        return total;
      },
      { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
}
export function runUsage(rows) {
  const value = nativeUsage(rows);
  return {
    requests: value.requests,
    inputTokens: value.input,
    outputTokens: value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
  };
}
