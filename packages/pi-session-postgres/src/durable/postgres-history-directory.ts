import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import type {
  HistoryDirectoryNode,
  HistoryDirectoryStore,
  HistoryRange,
} from "./history-directory.ts";

/** Immutable range directory operations share the caller's PG snapshot/ownership transaction. */
export class PostgresHistoryDirectory implements HistoryDirectoryStore {
  readonly #nodes = new Map<string, HistoryDirectoryNode>();
  constructor(
    readonly database: Transaction<Database>,
    readonly tenantId: string,
  ) {}
  async prefetch(root: string): Promise<void> {
    const { rows } = await sql<{ node: HistoryDirectoryNode }>`with recursive walk as (
      select n.* from pi_history_nodes n where n.tenant_id=${this.tenantId}::uuid and n.id=${root}::uuid
      union all select c.* from walk p cross join lateral(values(p.left_id),(p.right_id)) edge(id)
        join pi_history_nodes c on c.tenant_id=p.tenant_id and c.id=edge.id
    ) select node from walk`.execute(this.database);
    for (const row of rows) this.#nodes.set(row.node.id, row.node);
  }
  async read(id: string): Promise<HistoryDirectoryNode | undefined> {
    if (this.#nodes.has(id)) return this.#nodes.get(id);
    const { rows } = await sql<{ node: HistoryDirectoryNode }>`select node from pi_history_nodes
      where tenant_id=${this.tenantId}::uuid and id=${id}::uuid`.execute(this.database);
    return rows[0]?.node;
  }
  async insert(nodes: readonly HistoryDirectoryNode[]): Promise<void> {
    if (!nodes.length) return;
    await sql`insert into pi_history_nodes(tenant_id,id,left_id,right_id,source_id,conversation_id,through_seq,clear_task,retained_tasks,min_id,max_id,item_count,height,digest,node)
      values ${sql.join(
        nodes.map(
          (n) => sql`(${this.tenantId}::uuid,${n.id}::uuid,
        ${n.kind === "branch" ? n.left : null}::uuid,${n.kind === "branch" ? n.right : null}::uuid,
        ${n.kind === "range" ? n.range.sourceId : null}::text,${n.kind === "range" ? n.range.conversationId : null}::bigint,
        ${n.kind === "range" ? n.range.throughSequence : null}::bigint,${n.kind === "range" ? n.range.clearTask : null}::boolean,${n.kind === "range" ? (n.range.retainedTasks ?? null) : null}::bigint[],
        ${n.minId},${n.maxId},${n.count},${n.height},${n.digest},${JSON.stringify(n)}::jsonb)`,
        ),
      )}`.execute(this.database);
  }
  clip(range: HistoryRange, maximumId: number): Promise<HistoryRange | undefined> {
    return this.range({
      ...range,
      maximumId: Math.min(maximumId, range.maxId),
      minimumId: range.minId,
    });
  }
  async range(input: {
    sourceId: string;
    conversationId: number;
    throughSequence: number;
    clearTask: boolean;
    retainedTasks?: readonly number[];
    maximumId: number;
    minimumId?: number;
  }): Promise<HistoryRange | undefined> {
    // Compatible with ordinary append FKs, but excludes this stream's collector
    // until the new range/root ownership commits. No execution lease is taken.
    const stream =
      await sql`select id from pi_history_streams where tenant_id=${this.tenantId}::uuid
      and id=${input.sourceId} for key share`.execute(this.database);
    if (!stream.rows.length) return undefined;
    // Only small typed descriptors are counted/hashed; no native message body or
    // image is read. Publication bounds prevent late reserved IDs entering a Fork.
    const { rows } = await sql<{
      min_id: string | null;
      max_id: string | null;
      n: string;
      fingerprint: string;
    }>`
      select min(g.record_id)::text as min_id,max(g.record_id)::text as max_id,count(*)::text as n,
        encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(g.record_id,g.seq,g.ordinal,g.entry_body_id,g.entry_task_id,g.fields,g.cloud_origin)::text,'UTF8')),'hex'),'' order by g.record_id),''),'UTF8')),'hex') as fingerprint
      from pi_history_records g where g.tenant_id=${this.tenantId}::uuid and g.session_id=${input.sourceId}
        and g.record_kind='entry' and g.entry_conversation_id=${input.conversationId}
        and g.record_id between ${input.minimumId ?? 2} and ${input.maximumId} and g.seq<=${input.throughSequence}`.execute(
      this.database,
    );
    const row = rows[0]!;
    return Number(row.n) === 0
      ? undefined
      : {
          sourceId: input.sourceId,
          conversationId: input.conversationId,
          throughSequence: input.throughSequence,
          clearTask: input.clearTask,
          ...(input.retainedTasks ? { retainedTasks: [...input.retainedTasks] } : {}),
          minId: Number(row.min_id),
          maxId: Number(row.max_id),
          count: Number(row.n),
          fingerprint: row.fingerprint,
        };
  }
}
