import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { parseExecutionReference, type ToolSandboxAssignment } from "@pi-cloud/protocol";
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
export interface SandboxBindingReader {
  find(scope: ToolLogFact["scope"], wholeWriter: boolean): Promise<readonly SandboxBinding[]>;
  closeScope(scope: ToolLogFact["scope"], wholeWriter: boolean): Promise<void>;
  isAlive(instanceId: string): Promise<boolean>;
}
export interface SandboxBindings extends SandboxBindingReader {
  closePhysical(physicalActivationId: string): Promise<void>;
  closeTarget(target: SandboxExecutionDescriptor["target"]): Promise<void>;
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
  constructor(
    readonly database: Kysely<Database>,
    readonly sandboxDomainId: string,
    readonly instanceId: string,
    readonly baseUrl: string,
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
  }
  async release(bindingId: string, assignment: ToolSandboxAssignment): Promise<void> {
    await this.database
      .deleteFrom("sandbox_tool_bindings")
      .where("tenant_id", "=", assignment.tenantId)
      .where("run_id", "=", parseExecutionReference(assignment.executionReference).runId)
      .where("binding_id", "=", bindingId)
      .execute();
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
  async closeScope(scope: ToolLogFact["scope"], wholeWriter: boolean): Promise<void> {
    const query = this.database
      .updateTable("sandbox_tool_bindings")
      .set({ dispatch_closed: true })
      .where("tenant_id", "=", scope.tenantId!);
    await (
      wholeWriter
        ? query.where("writer_id", "=", scope.writerId)
        : query.where("run_id", "=", scope.runId)
    ).execute();
  }
  async closeTarget(target: SandboxExecutionDescriptor["target"]): Promise<void> {
    await this.database
      .updateTable("sandbox_tool_bindings")
      .set({ dispatch_closed: true })
      .where(sql<string>`descriptor->'target'->>'sandboxId'`, "=", target.sandboxId)
      .where(sql<string>`descriptor->'target'->>'apiUrl'`, "=", target.apiUrl)
      .where(sql<string>`descriptor->'target'->>'bootId'`, "=", target.bootId)
      .execute();
  }
  async closePhysical(physicalActivationId: string): Promise<void> {
    await this.database
      .updateTable("sandbox_tool_bindings")
      .set({ dispatch_closed: true })
      .where("owner_instance_id", "=", this.instanceId)
      .where(sql<string>`snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .execute();
  }
  async adopt(
    physicalActivationId: string,
  ): Promise<readonly (SandboxBinding & { closed: boolean })[]> {
    await this.database
      .updateTable("sandbox_tool_bindings")
      .set({ owner_instance_id: this.instanceId })
      .where("sandbox_domain_id", "=", this.sandboxDomainId)
      .where(sql<string>`snapshot->>'physicalActivationId'`, "=", physicalActivationId)
      .execute();
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
}
