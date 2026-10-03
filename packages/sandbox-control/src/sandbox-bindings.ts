import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  parseExecutionReference,
  type ExecutionLogPosition,
  type SandboxBindingChange,
  type ToolSandboxAssignment,
} from "@pi-cloud/protocol";
import type { ToolLogFact } from "./workflow-command-dispatcher.ts";
import type { SandboxBindingSnapshot, SandboxExecutionDescriptor } from "./sandbox-execution.ts";

export type SandboxBinding = Readonly<{
  bindingId: string;
  instanceId: string;
  baseUrl: string;
  dispatchClosed: boolean;
  descriptor: SandboxExecutionDescriptor;
  snapshot: SandboxBindingSnapshot;
}>;
export type SandboxBindingRecord = SandboxBinding &
  Readonly<{
    tenantId: string;
    runId: string;
    writerId: string;
    piSessionId: string;
    revision: string;
  }>;
export type BindingViewPage = Readonly<{
  partitions: readonly number[];
  partitionCount: number;
  after?: Pick<SandboxBindingRecord, "runId" | "bindingId">;
}>;
export const BINDING_VIEW_PAGE_SIZE = 256;
export interface SandboxBindingReader {
  find(scope: ToolLogFact["scope"], wholeWriter: boolean): Promise<readonly SandboxBinding[]>;
  closeScope(
    scope: ToolLogFact["scope"],
    wholeWriter: boolean,
    retryQuarantined?: boolean,
  ): Promise<void>;
  isAlive(instanceId: string): Promise<boolean>;
}
export interface SandboxBindings extends SandboxBindingReader {
  releaseAfterPhysicalAbsence(physicalActivationId: string): Promise<void>;
  confirmPhysicalClosure(physicalActivationId: string): Promise<void>;
  register(
    bindingId: string,
    descriptor: SandboxExecutionDescriptor,
    snapshot: SandboxBindingSnapshot,
  ): Promise<void>;
  release(bindingId: string, assignment: ToolSandboxAssignment): Promise<void>;
  adopt(physicalActivationId: string): Promise<readonly (SandboxBinding & { closed: boolean })[]>;
  inventory(sandboxId: string): Promise<readonly SandboxBinding[]>;
}

/** Bounded immutable transport metadata, with no per-Tool lease/Run authority query. */
export class PostgresSandboxBindings implements SandboxBindings {
  readonly #waiters = new Set<() => void>();
  constructor(
    readonly database: Kysely<Database>,
    readonly sandboxDomainId: string,
    readonly instanceId: string,
    readonly baseUrl: string,
    readonly publishChanges: (ids: readonly string[]) => Promise<void>,
  ) {}

  async register(
    bindingId: string,
    descriptor: SandboxExecutionDescriptor,
    snapshot: SandboxBindingSnapshot,
  ): Promise<void> {
    const identity = parseExecutionReference(snapshot.assignment.executionReference);
    await this.database
      .insertInto("sandbox_tool_bindings")
      .values({
        binding_id: bindingId,
        tenant_id: snapshot.assignment.tenantId,
        run_id: identity.runId,
        writer_id: identity.leaseId,
        sandbox_domain_id: this.sandboxDomainId,
        owner_instance_id: this.instanceId,
        descriptor,
        snapshot,
      })
      .executeTakeFirstOrThrow();
    await this.publishChanges([bindingId]);
  }
  async release(bindingId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const removed = await this.database
      .deleteFrom("sandbox_tool_bindings")
      .where("tenant_id", "=", assignment.tenantId)
      .where("run_id", "=", parseExecutionReference(assignment.executionReference).runId)
      .where("binding_id", "=", bindingId)
      .where(sql<boolean>`dispatch_closed and closure_result->>'outcome'='stopped'`)
      .returning("binding_id")
      .executeTakeFirst();
    if (
      !removed &&
      (await this.database
        .selectFrom("sandbox_tool_bindings")
        .select("binding_id")
        .where("binding_id", "=", bindingId)
        .where("tenant_id", "=", assignment.tenantId)
        .where("run_id", "=", parseExecutionReference(assignment.executionReference).runId)
        .executeTakeFirst())
    )
      throw new Error("Binding execution closure is unconfirmed");
    await this.publishChanges([bindingId]);
  }
  async releaseAfterPhysicalAbsence(physicalActivationId: string): Promise<void> {
    // Caller has confirmed native destruction/absence on the recorded node.
    const rows = await this.database
      .deleteFrom("sandbox_tool_bindings")
      .where("sandbox_domain_id", "=", this.sandboxDomainId)
      .where(sql<string>`snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .returning("binding_id")
      .execute();
    await this.publishChanges(rows.map((row) => row.binding_id));
    this.#notify();
  }
  #query() {
    return this.database
      .selectFrom("sandbox_tool_bindings as binding")
      .innerJoin(
        "sandbox_control_instances as owner",
        "owner.instance_id",
        "binding.owner_instance_id",
      )
      .select([
        "binding.binding_id as bindingId",
        "owner.instance_id as instanceId",
        "owner.owner_base_url as baseUrl",
        "binding.dispatch_closed as dispatchClosed",
        "binding.descriptor",
        "binding.snapshot",
        "binding.tenant_id as tenantId",
        "binding.run_id as runId",
        "binding.writer_id as writerId",
        "binding.pi_session_id as piSessionId",
        "binding.revision",
      ]);
  }
  async find(
    scope: ToolLogFact["scope"],
    wholeWriter: boolean,
  ): Promise<readonly SandboxBinding[]> {
    const query = this.#query().where("binding.tenant_id", "=", scope.tenantId!);
    return (await (
      wholeWriter
        ? query.where("binding.writer_id", "=", scope.writerId)
        : query.where("binding.run_id", "=", scope.runId)
    ).execute()) as unknown as SandboxBinding[];
  }
  async closeScope(
    scope: ToolLogFact["scope"],
    wholeWriter: boolean,
    retryQuarantined = false,
  ): Promise<void> {
    const query = this.database
      .updateTable("sandbox_tool_bindings")
      .set({ dispatch_closed: true })
      .$if(retryQuarantined, (q) =>
        q.set({
          closure_revision: sql`case when closure_result->>'outcome'='quarantined' then null else closure_revision end`,
          closure_result: sql`case when closure_result->>'outcome'='quarantined' then null else closure_result end`,
        }),
      )
      .where("tenant_id", "=", scope.tenantId!);
    const closed = await (
      wholeWriter
        ? query.where("writer_id", "=", scope.writerId)
        : query.where("run_id", "=", scope.runId)
    )
      .returning(["binding_id", "run_id"])
      .execute();
    await this.publishChanges(closed.map((r) => r.binding_id));
    await this.#waitForClosure(closed);
  }
  async acknowledgeClosure(
    change: SandboxBindingChange,
    position: ExecutionLogPosition,
    outcome: "stopped" | "quarantined",
  ): Promise<void> {
    if (!change.closed) throw new Error("Only a closed control fact can acknowledge stopping");
    await this.database
      .updateTable("sandbox_tool_bindings")
      .set({ closure_result: { outcome, version: change.version, position } })
      .where("tenant_id", "=", change.scope.tenantId)
      .where("binding_id", "=", change.entityId)
      .where("run_id", "=", change.runId)
      .where("pi_session_id", "=", change.scope.piSessionId)
      .where("dispatch_closed", "=", true)
      .where("closure_revision", "<=", change.version)
      .where(
        sql<boolean>`closure_result is null or
        ((closure_result->>'version')::bigint <= ${change.version}::bigint
          and (closure_result->>'outcome'<>'stopped' or ${outcome}='stopped'))`,
      )
      .execute();
    this.#notify();
  }
  #notify(): void {
    for (const wake of this.#waiters) wake();
  }
  async #waitForClosure(ids: readonly { run_id: string; binding_id: string }[]): Promise<void> {
    if (!ids.length) return;
    const deadline = performance.now() + 30_000;
    for (;;) {
      // Register before the read: a local ACK cannot race between read and wait.
      let timer: NodeJS.Timeout | undefined;
      let wake!: () => void;
      const changed = new Promise<void>((resolve) => {
        wake = resolve;
      });
      this.#waiters.add(wake);
      try {
        const pending = await this.database
          .selectFrom("sandbox_tool_bindings")
          .select("binding_id")
          .where(
            sql<boolean>`(run_id,binding_id) in (select * from unnest(${ids.map((r) => r.run_id)}::uuid[], ${ids.map((r) => r.binding_id)}::uuid[]))`,
          )
          .where("closure_result", "is", null)
          .limit(1)
          .executeTakeFirst();
        if (!pending) return;
        if (performance.now() >= deadline)
          throw new Error("Ordered binding closure is still pending");
        // Fallback covers an ACK by a different control-plane owner. No Tool
        // or probe uses this lifecycle-only wait.
        timer = setTimeout(wake, 250);
        await changed;
      } finally {
        clearTimeout(timer);
        this.#waiters.delete(wake);
      }
    }
  }
  async confirmPhysicalClosure(physicalActivationId: string): Promise<void> {
    // The resource transaction has already closed every binding, including
    // those left by a previous controller. This port only confirms propagation.
    const closed = await this.database
      .selectFrom("sandbox_tool_bindings")
      .select(["binding_id", "dispatch_closed"])
      .where("sandbox_domain_id", "=", this.sandboxDomainId)
      .where(sql<string>`snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .execute();
    if (closed.some((row) => !row.dispatch_closed))
      throw new Error("Physical binding closure has not committed");
    await this.publishChanges(closed.map((r) => r.binding_id));
  }
  async adopt(
    physicalActivationId: string,
  ): Promise<readonly (SandboxBinding & { closed: boolean })[]> {
    const adopted = await this.database
      .updateTable("sandbox_tool_bindings")
      .set({ owner_instance_id: this.instanceId })
      .where("sandbox_domain_id", "=", this.sandboxDomainId)
      .where(sql<string>`snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .returning("binding_id")
      .execute();
    await this.publishChanges(adopted.map((r) => r.binding_id));
    return (await this.#query()
      .where("binding.sandbox_domain_id", "=", this.sandboxDomainId)
      .leftJoin("runs as run", "run.id", "binding.run_id")
      .select(
        sql<boolean>`binding.dispatch_closed or run.id is null or run.state in ('completed','failed','cancelled','timed_out') or run.output_sealed_at is not null`.as(
          "closed",
        ),
      )
      .where(sql<string>`binding.snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .execute()) as unknown as (SandboxBinding & { closed: boolean })[];
  }
  async inventory(sandboxId: string): Promise<readonly SandboxBinding[]> {
    return (await this.#query()
      .where("binding.sandbox_domain_id", "=", this.sandboxDomainId)
      .where(sql<string>`binding.snapshot->'assignment'->>'sandboxId'`, "=", sandboxId)
      .execute()) as unknown as SandboxBinding[];
  }
  async isAlive(instanceId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom("sandbox_control_instances")
      .select("instance_id")
      .where("instance_id", "=", instanceId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    return row !== undefined;
  }

  async loadView(page: BindingViewPage): Promise<readonly SandboxBindingRecord[]> {
    if (!page.partitions.length) return [];
    const rows = await this.#query()
      .innerJoin("pi_sessions as session", (join) =>
        join
          .onRef("session.tenant_id", "=", "binding.tenant_id")
          .onRef("session.id", "=", "binding.pi_session_id"),
      )
      .where(
        sql<boolean>`session.session_hash % ${page.partitionCount} = any(${[...page.partitions]}::int[])`,
      )
      .$if(page.after !== undefined, (q) =>
        q.where(
          sql<boolean>`(binding.run_id,binding.binding_id) > (${page.after!.runId}::uuid,${page.after!.bindingId}::uuid)`,
        ),
      )
      .orderBy("binding.run_id")
      .orderBy("binding.binding_id")
      .limit(BINDING_VIEW_PAGE_SIZE)
      .execute();
    return rows as unknown as SandboxBindingRecord[];
  }
  async readChange(
    change: import("@pi-cloud/protocol").SandboxBindingChange,
  ): Promise<SandboxBindingRecord | undefined> {
    return (await this.#query()
      .where("binding.tenant_id", "=", change.scope.tenantId)
      .where("binding.pi_session_id", "=", change.scope.piSessionId)
      .where("binding.run_id", "=", change.runId)
      .where("binding.binding_id", "=", change.entityId)
      .executeTakeFirst()) as unknown as SandboxBindingRecord | undefined;
  }
}
