import { isDeepStrictEqual } from "node:util";
import { isTerminalRunState } from "@pi-cloud/domain";
import type { Database } from "@pi-cloud/database";
import type { AcceptedSubagentCommand } from "@pi-cloud/runtime-core/accepted-fact";
import type { KafkaAcceptedFactRecord } from "@pi-cloud/runtime-core/kafka-accepted-fact-consumer";
import {
  createExecutionReference,
  parseExecutionReference,
  type SubagentHostRequest,
  type SubagentControlResult,
  type SessionControlChange,
} from "@pi-cloud/protocol";
import {
  PostgresSubagentJobProvider,
  type StartCloudSubagentJobInput,
  type CloudSubagentTreePolicy,
  type SubagentDirectoryTarget,
} from "@pi-cloud/subagent-control/subagent-jobs";
import { PostgresSubagentSupervisorChannel } from "@pi-cloud/subagent-control/subagent-supervisor";
import { sql, type Kysely, type Selectable, type Updateable } from "kysely";
import { HttpSupervisorManagementClient } from "./http-supervisor-management.ts";
import { SubagentReadViews } from "./subagent-read-views.ts";
import { SubagentPendingCommands, subagentFamily } from "./subagent-pending-commands.ts";

type CommandRow = Selectable<Database["subagent_control_commands"]>;
const object = (value: unknown) => value as Record<string, unknown>;

/** The consumer admits in order; preparation and result notification run off-stack. */
export class SubagentController {
  readonly #jobs: PostgresSubagentJobProvider;
  readonly #supervisor: PostgresSubagentSupervisorChannel;
  readonly #clients = new Map<string, HttpSupervisorManagementClient>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #deliveryTails = new Map<string, Promise<void>>();
  readonly #pending = new SubagentPendingCommands();
  readonly #views = new SubagentReadViews();
  readonly #routes = new SubagentReadViews();
  readonly #dirty = new Set<string>();
  readonly #retryAt = new Map<string, number>();
  readonly #deadlines = new Map<string, number>();
  #generation = 0;
  #recovery: Promise<void> | undefined;
  #recoveryRequest: { partitions?: readonly number[]; current: () => boolean } | undefined;
  #nextReap = Infinity;
  #recoveryPlan: { partitions?: readonly number[]; current: () => boolean } | undefined;
  #closed = false;
  #scan: Promise<void> | undefined;
  #again = false;
  #reapRequested = false;
  readonly #timer: NodeJS.Timeout;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      managementToken: string;
      allowInsecureHttp: boolean;
      ownsPartition(partition: number): boolean;
      treePolicy?: CloudSubagentTreePolicy;
      validateDirectory?(target: SubagentDirectoryTarget): Promise<void>;
      sendInput?(input: {
        tenantId: string;
        sessionId: string;
        turnId: string;
        requestId: string;
        message: string;
        delivery: "notify" | "steer" | "follow_up";
      }): Promise<void>;
      deliver?(lease: string, request: SubagentHostRequest): Promise<unknown>;
      onError?(error: unknown): void;
    },
  ) {
    this.#supervisor = new PostgresSubagentSupervisorChannel(options.database);
    this.#jobs = new PostgresSubagentJobProvider({
      database: options.database,
      ...(options.treePolicy ? { treePolicy: options.treePolicy } : {}),
      ...(options.validateDirectory ? { validateDirectory: options.validateDirectory } : {}),
      nativeLanes: {
        childAnchor() {
          throw new Error("The Worker must freeze the Child context anchor");
        },
        createChildLane: (input) =>
          this.#host(input.executionReference, {
            action: "prepare_lane",
            executionReference: input.executionReference,
            lane: input.lane,
            anchor: input.at,
          }),
      },
    });
    this.#timer = setInterval(() => {
      const now = performance.now();
      for (const [id, due] of this.#retryAt)
        if (due <= now) {
          this.#retryAt.delete(id);
          if (this.#pending.get(id)) this.#dirty.add(id);
        }
      for (const [id, due] of this.#deadlines)
        if (due <= now) {
          this.#deadlines.delete(id);
          const ref = this.#pending.get(id);
          if (ref) {
            this.#views.invalidate(ref.family);
            this.#dirty.add(id);
          }
        }
      if (now >= this.#nextReap) {
        this.#nextReap = Infinity;
        this.#reapRequested = true;
      }
      if (this.#recoveryRequest && !this.#recovery && this.#pending.size < 8192)
        void this.recover(this.#recoveryRequest.partitions, this.#recoveryRequest.current).catch(
          () => {},
        );
      if (this.#dirty.size || this.#reapRequested) this.wake();
    }, 1000);
    this.#timer.unref();
  }

  async #host<T = void>(lease: string, request: SubagentHostRequest): Promise<T> {
    if (this.options.deliver) return (await this.options.deliver(lease, request)) as T;
    const identity = parseExecutionReference(lease);
    const route = await this.#routes.read(identity.leaseId, lease, () =>
      this.options.database
        .selectFrom("runs as a")
        .innerJoin("sandboxes as s", "s.id", "a.sandbox_id")
        .innerJoin("supervisor_hosts as h", "h.supervisor_id", "s.supervisor_id")
        .select("h.management_base_url")
        .where("a.id", "=", identity.runId)
        .where("a.lease_id", "=", identity.leaseId)
        .where("a.fencing_token", "=", String(identity.fencingToken))
        .executeTakeFirst(),
    );
    if (!route) throw new Error("Subagent owning Worker is unavailable");
    let client = this.#clients.get(route.management_base_url);
    if (!client) {
      client = new HttpSupervisorManagementClient({
        baseUrl: route.management_base_url,
        managementToken: this.options.managementToken,
        allowInsecureHttp: this.options.allowInsecureHttp,
      });
      this.#clients.set(route.management_base_url, client);
    }
    try {
      return (await client.subagent(request)) as T;
    } catch (error) {
      this.#routes.invalidate(identity.leaseId);
      throw error;
    }
  }

  reset(): void {
    this.#generation++;
    this.#pending.reset();
    this.#views.reset();
    this.#routes.reset();
    this.#dirty.clear();
    this.#retryAt.clear();
    this.#deadlines.clear();
    this.#recoveryRequest = undefined;
    this.#recoveryPlan = undefined;
  }
  async recover(
    partitions?: readonly number[],
    current: () => boolean = () => true,
  ): Promise<void> {
    if (this.#closed || !current()) return;
    this.#recoveryRequest = { ...(partitions ? { partitions } : {}), current };
    this.#recoveryPlan = this.#recoveryRequest;
    if (this.#recovery) {
      await this.#recovery.catch(() => {});
      if (!this.#closed && current()) return this.recover(partitions, current);
      return;
    }
    const generation = this.#generation;
    this.#recovery = (async () => {
      this.#recoveryRequest = undefined;
      this.#pending.overflow = false;
      let after = "0";
      for (;;) {
        let query = this.options.database
          .selectFrom("subagent_control_commands")
          .selectAll()
          .where("ordinal", ">", after)
          .where(
            sql<boolean>`delivered_at is null or (target_session_id is not null and input_consumed_at is null and response->'result'->>'state'='accepted')`,
          )
          .orderBy("ordinal")
          .limit(128);
        if (partitions) {
          if (!partitions.length) return;
          query = query.where("partition", "in", [...partitions]);
        }
        const rows = await query.execute();
        if (!current() || generation !== this.#generation || this.#closed) return;
        for (const row of rows) this.#remember(row, true);
        if (rows.length < 128) break;
        if (this.#pending.overflow) {
          this.#recoveryRequest = { ...(partitions ? { partitions } : {}), current };
          break;
        }
        after = rows.at(-1)!.ordinal;
      }
      this.#reapRequested = true;
      this.wake();
    })()
      .catch((error) => {
        if (generation === this.#generation && current())
          this.#recoveryRequest = { ...(partitions ? { partitions } : {}), current };
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.#recovery = undefined;
      });
    return this.#recovery;
  }
  #remember(row: CommandRow, bootstrap = false): void {
    if (this.#closed || (!bootstrap && !this.options.ownsPartition(row.partition))) return;
    if (this.#pending.remember(row)) this.#dirty.add(row.id);
    else if (!this.#pending.get(row.id)) {
      this.#dirty.delete(row.id);
      this.#deadlines.delete(row.id);
      this.#retryAt.delete(row.id);
    }
    if (this.#pending.overflow) this.#recoveryRequest = this.#recoveryPlan;
  }
  #touch(tenant: string, session: string): void {
    const family = subagentFamily(tenant, session);
    this.#views.invalidate(family);
    for (const ref of this.#pending.entries()) if (ref.family === family) this.#dirty.add(ref.id);
    this.wake();
  }
  async #updateCommand(
    id: string,
    patch: Updateable<Database["subagent_control_commands"]>,
  ): Promise<void> {
    const row = await this.options.database
      .updateTable("subagent_control_commands")
      .set(patch)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (row) this.#remember(row);
    else this.#pending.remove(id);
  }
  async #row(id: string): Promise<CommandRow | undefined> {
    const cached = this.#pending.row(id);
    if (cached) return cached;
    const generation = this.#generation;
    const row = await this.options.database
      .selectFrom("subagent_control_commands")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (generation !== this.#generation || this.#closed) return;
    if (row) this.#pending.remember(row);
    else this.#pending.remove(id);
    return row;
  }
  async changed(change: SessionControlChange, current: () => boolean): Promise<void> {
    if (!current() || this.#closed || !change.entity.startsWith("subagent_")) return;
    const generation = this.#generation,
      family = subagentFamily(change.scope.tenantId, change.scope.piSessionId);
    if (change.entity === "subagent_command") {
      const row = await this.options.database
        .selectFrom("subagent_control_commands")
        .selectAll()
        .where("tenant_id", "=", change.scope.tenantId)
        .where("id", "=", change.entityId)
        .executeTakeFirst();
      if (!current() || generation !== this.#generation) return;
      if (row) this.#remember(row);
      else {
        this.#pending.remove(change.entityId, BigInt(change.version));
        this.#dirty.delete(change.entityId);
      }
    } else {
      this.#views.invalidate(family);
      for (const ref of this.#pending.entries()) if (ref.family === family) this.#dirty.add(ref.id);
    }
    this.wake();
  }

  async consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void> {
    if (current?.() === false || this.#closed) return;
    if (record.fact.kind === "subagent_command") {
      const command = record.fact;
      const row = await this.options.database
        .insertInto("subagent_control_commands")
        .values({
          id: command.factId,
          tenant_id: command.scope.tenantId,
          run_id: command.scope.runId,
          partition: record.partition,
          command: object(command),
          delivered_at: null,
          input_consumed_at: null,
        })
        .onConflict((c) =>
          c.column("id").doUpdateSet({ id: sql.ref("subagent_control_commands.id") }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      this.#remember(row);
      if (!isDeepStrictEqual(row.command, object(command)))
        throw new Error("Subagent request identity was reused");
      if (
        !row.response &&
        command.request.action !== "send" &&
        (await this.#invocationEnded(command))
      ) {
        await this.#respond(row, {
          requestId: row.id,
          ok: false,
          error: "Subagent tool invocation has already ended",
        });
        this.wake();
        return;
      }
      // Reserve identity before consuming later send/cancel requests for the key.
      if (command.request.action === "start" && !row.child_execution_id && !row.response) {
        try {
          const child = await this.#jobs.start(this.#startInput(command, row), true);
          if (child.state === "preparing")
            this.#nextReap = Math.min(this.#nextReap, performance.now() + 20 * 60_000);
          await this.#updateCommand(row.id, { child_execution_id: child.executionId });
        } catch (error) {
          await this.#respond(row, { requestId: row.id, ok: false, error: this.#error(error) });
        }
      }
      if (command.request.action === "contact" && !row.supervisor_request_id && !row.response) {
        try {
          const request = await this.#supervisor.contact({
            tenantId: row.tenant_id,
            childSessionId: command.scope.sessionId,
            childRunId: row.run_id,
            requestId: row.id,
            reason: command.request.reason,
            message: command.request.message,
            ...(command.request.interview ? { interview: command.request.interview } : {}),
          });
          await this.#updateCommand(row.id, {
            supervisor_request_id: request.requestId,
            child_execution_id: request.executionId,
          });
        } catch (error) {
          await this.#respond(row, { requestId: row.id, ok: false, error: this.#error(error) });
        }
      }
    }
    if (record.fact.kind === "pi_session_append" || record.fact.kind === "tool_invocation") {
      for (const item of record.fact.items) {
        if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          item.entry.message.role === "user"
        ) {
          // The native prompt proves startup reached the Agent; retry inputs
          // queued while its Run was provisioning/restoring without a timer tick.
          this.#touch(record.fact.scope.tenantId, record.fact.scope.piSessionId);
        }
        if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          item.entry.message.role === "toolResult" &&
          item.entry.message.toolName === "subagent"
        ) {
          this.#reapRequested = true;
          this.#touch(record.fact.scope.tenantId, record.fact.scope.piSessionId);
        }
        if (item.kind === "entry" && item.entry.id.startsWith("pc-agent-input-")) {
          const consumed = await this.options.database
            .updateTable("subagent_control_commands")
            .set({ input_consumed_at: new Date() })
            .where("id", "=", item.entry.id.slice("pc-agent-input-".length))
            .where("tenant_id", "=", record.fact.scope.tenantId)
            .where("target_session_id", "=", record.fact.scope.sessionId)
            .returningAll()
            .execute();
          for (const row of consumed) this.#remember(row);
        }
      }
    }
    if (record.fact.kind === "execution_seal") this.#reapRequested = true;
    if (record.fact.kind === "execution_seal")
      this.#touch(record.fact.scope.tenantId, record.fact.scope.piSessionId);
    else if (record.fact.kind === "subagent_command") this.wake();
  }

  #startInput(command: AcceptedSubagentCommand, row: CommandRow): StartCloudSubagentJobInput {
    const request = command.request;
    if (request.action !== "start") throw new Error("Expected a Child start command");
    return {
      tenantId: command.scope.tenantId,
      parentSessionId: command.scope.sessionId,
      parentRunId: command.scope.runId,
      parentExecutionReference: command.executionReference,
      parentToolCallId: command.toolCallId,
      workflowRunId: command.workflowId,
      stepIndex: Number(row.ordinal),
      agentName: "cloud-child",
      prompt: request.task,
      contextMode: request.context,
      contextAnchor: request.anchor,
      sandboxMode: request.sandbox,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
      ...(request.tools ? { requestedToolCapabilities: request.tools } : {}),
    };
  }

  wake(): void {
    if (this.#closed) return;
    if (this.#scan) {
      this.#again = true;
      return;
    }
    this.#scan = this.#drain()
      .catch((error) => {
        this.#nextReap = Math.min(this.#nextReap, performance.now() + 1000);
        this.options.onError?.(error);
      })
      .finally(() => {
        this.#scan = undefined;
        if (this.#again) {
          this.#again = false;
          this.wake();
        }
      });
  }

  async #drain(): Promise<void> {
    if (this.#reapRequested) {
      this.#reapRequested = false;
      await this.#jobs.reapStalePreparations();
      await this.#retireChildren();
      const next = await this.options.database
        .selectFrom("subagent_executions")
        .select(sql<Date | null>`min(created_at)`.as("created"))
        .where("state", "=", "preparing")
        .executeTakeFirstOrThrow();
      if (next.created)
        this.#nextReap = Math.min(
          this.#nextReap,
          performance.now() +
            Math.max(0, new Date(next.created).valueOf() + 20 * 60_000 - Date.now()),
        );
    }
    const available = 128 - this.#inflight.size;
    if (available <= 0) return;
    const generation = this.#generation;
    const ready = this.#pending
      .entries()
      .filter(
        (r) =>
          this.#dirty.has(r.id) &&
          !this.#inflight.has(r.id) &&
          this.options.ownsPartition(r.partition) &&
          (this.#retryAt.get(r.id) ?? 0) <= performance.now(),
      )
      .sort((a, b) => (a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0))
      .slice(0, available);
    for (const ref of ready) {
      this.#dirty.delete(ref.id);
      let row: CommandRow | undefined;
      try {
        row = await this.#row(ref.id);
      } catch (error) {
        this.#retryAt.set(ref.id, performance.now() + 1000);
        this.#dirty.add(ref.id);
        this.options.onError?.(error);
        continue;
      }
      if (this.#closed || generation !== this.#generation) return;
      if (!row) continue;
      const command = row.command as unknown as AcceptedSubagentCommand;
      const ordered = ["send", "cancel"].includes(command.request.action);
      this.#schedule(
        row,
        () => (ref.responsePending ? this.#work(row) : this.#redeliverInput(row)),
        ordered ? command.scope.piSessionId : undefined,
      );
    }
  }

  #schedule(row: CommandRow, work: () => Promise<boolean | void>, orderedKey?: string): void {
    if (
      this.#closed ||
      this.#inflight.size >= 128 ||
      !this.options.ownsPartition(row.partition) ||
      this.#inflight.has(row.id)
    )
      return;
    const previous = orderedKey ? this.#deliveryTails.get(orderedKey) : undefined;
    let changed = false;
    const task = (previous ?? Promise.resolve())
      .then(async () => {
        if (
          this.#closed ||
          !this.options.ownsPartition(row.partition) ||
          !this.#pending.get(row.id)
        )
          return;
        changed = (await work()) === true;
      })
      .catch((error) => {
        if (this.#pending.get(row.id)) {
          this.#retryAt.set(row.id, performance.now() + 1000);
          this.#dirty.add(row.id);
        }
        this.options.onError?.(error);
      })
      .finally(() => {
        this.#inflight.delete(row.id);
        this.#pending.releaseBody(row.id, row.revision);
        if (changed || this.#dirty.has(row.id)) this.wake();
      });
    if (orderedKey) {
      this.#deliveryTails.set(orderedKey, task);
      void task.finally(() => {
        if (this.#deliveryTails.get(orderedKey) === task) this.#deliveryTails.delete(orderedKey);
      });
    }
    this.#inflight.set(row.id, task);
  }

  async #target(command: AcceptedSubagentCommand): Promise<string> {
    if (!("target" in command.request)) throw new Error("Command has no target");
    const target = command.request.target;
    return this.#routes.read(
      subagentFamily(command.scope.tenantId, command.scope.piSessionId),
      `target:${command.scope.runId}:${command.workflowId}:${target}`,
      async () => {
        const rows = await this.options.database
          .selectFrom("subagent_executions as e")
          .innerJoin("sessions as s", "s.id", "e.child_session_id")
          .select(["e.id", "e.child_session_id"])
          .where("e.tenant_id", "=", command.scope.tenantId)
          .where("s.pi_session_id", "=", command.scope.piSessionId)
          .execute();
        const exact = rows.find((r) => r.id === target || r.child_session_id === target);
        if (exact) return exact.id;
        const keyed = await this.options.database
          .selectFrom("subagent_control_commands")
          .select("child_execution_id")
          .where("tenant_id", "=", command.scope.tenantId)
          .where("run_id", "=", command.scope.runId)
          .where(sql<string>`command->>'workflowId'`, "=", command.workflowId)
          .where(sql<string>`command->'request'->>'key'`, "=", target)
          .orderBy("ordinal", "asc")
          .executeTakeFirst();
        if (keyed?.child_execution_id) return keyed.child_execution_id;
        throw new Error("Subagent target does not belong to this Session");
      },
    );
  }

  async #work(row: CommandRow): Promise<boolean | void> {
    if (this.#closed || !this.options.ownsPartition(row.partition)) return;
    const command = row.command as unknown as AcceptedSubagentCommand;
    const attempt = await this.#views.read(
      subagentFamily(command.scope.tenantId, command.scope.piSessionId),
      `closed:${row.run_id}`,
      () =>
        this.options.database
          .selectFrom("runs")
          .select("output_sealed_at")
          .where("id", "=", row.run_id)
          .executeTakeFirst(),
    );
    if (!attempt || attempt.output_sealed_at !== null) {
      // A mailbox message admitted before the seal survives its sender. Its
      // receiver still owns delivery/consumption; starting new work does not.
      if (command.request.action === "send" && !row.response) {
        const receipt = await this.#sendMessage(row, command);
        if (!receipt) return;
        await this.#respond(row, { requestId: row.id, ok: true, result: receipt });
      }
      if (row.child_execution_id && command.request.action === "start")
        await this.#jobs.cancel(row.tenant_id, row.child_execution_id);
      await this.#updateCommand(row.id, { delivered_at: new Date() });
      return true;
    }
    if (row.response) {
      await this.#host(command.executionReference, {
        action: "result",
        executionReference: command.executionReference,
        response: row.response as unknown as SubagentControlResult,
      });
      await this.#updateCommand(row.id, { delivered_at: new Date() });
      return true;
    }
    try {
      let result: Record<string, unknown>;
      if (command.request.action === "start") {
        if (!row.child_execution_id) return;
        let child = await this.#status(command, row.child_execution_id);
        if (child.state === "preparing") {
          child = await this.#jobs.prepareChild(this.#startInput(command, row), child);
          this.#touch(command.scope.tenantId, command.scope.piSessionId);
        }
        if (child.state === "queued")
          await this.#host(command.executionReference, {
            action: "schedule",
            runId: child.childRunId,
          });
        result = object(child);
      } else if (command.request.action === "contact") {
        if (!row.supervisor_request_id) return;
        const request = await this.#views.read(
          subagentFamily(command.scope.tenantId, command.scope.piSessionId),
          `request:${row.supervisor_request_id}`,
          () => this.#supervisor.request(row.tenant_id, row.supervisor_request_id!),
        );
        if (request.expectsReply && request.replyMessage === undefined) {
          if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now())
            throw new Error("Supervisor reply timed out");
          if (request.expiresAt)
            this.#deadlines.set(
              row.id,
              performance.now() + Math.max(0, Date.parse(request.expiresAt) - Date.now()),
            );
          return;
        }
        result = object(request);
      } else if (command.request.action === "supervisor") {
        const input = command.request;
        if (input.operation === "pending")
          result = {
            requests: await this.#views.read(
              subagentFamily(command.scope.tenantId, command.scope.piSessionId),
              `requests:${command.scope.sessionId}`,
              () => this.#supervisor.pendingForParent(row.tenant_id, command.scope.sessionId),
            ),
          };
        else {
          if (!input.requestId) throw new Error("A supervisor request ID is required");
          const request =
            input.operation === "reply" && !row.supervisor_request_id
              ? await this.#supervisor.reply({
                  tenantId: row.tenant_id,
                  parentSessionId: command.scope.sessionId,
                  requestId: input.requestId,
                  message: input.message ?? "",
                })
              : await this.#supervisor.requestForParent(
                  row.tenant_id,
                  command.scope.sessionId,
                  input.requestId,
                );
          if (input.operation === "reply" && !row.supervisor_request_id)
            this.#touch(command.scope.tenantId, command.scope.piSessionId);
          if (!row.supervisor_request_id) {
            await this.#updateCommand(row.id, {
              supervisor_request_id: request.requestId,
              child_execution_id: request.executionId,
            });
            this.wake();
          }
          const child = await this.#status(command, request.executionId);
          if (["queued", "running", "preparing"].includes(child.state)) return;
          result = object(await this.#result(command, request.executionId));
        }
      } else if (command.request.action === "send") {
        const receipt = await this.#sendMessage(row, command);
        if (!receipt) return;
        result = receipt;
      } else {
        const target = row.child_execution_id ?? (await this.#target(command));
        if (!row.child_execution_id)
          await this.#updateCommand(row.id, { child_execution_id: target });
        if (command.request.action === "cancel") {
          result = object(await this.#jobs.cancel(row.tenant_id, target));
          this.#touch(command.scope.tenantId, command.scope.piSessionId);
        } else {
          const child = await this.#status(command, target);
          const blocked =
            command.request.action === "wait"
              ? await this.#views.read(
                  subagentFamily(command.scope.tenantId, command.scope.piSessionId),
                  `blocked:${target}`,
                  () => this.#supervisor.latestForExecution(row.tenant_id, target),
                )
              : undefined;
          if (blocked?.expectsReply && blocked.replyMessage === undefined) {
            result = {
              ...child,
              state: "blocked",
              supervisorRequest: blocked,
              output: `Child needs supervisor input: ${blocked.message}. Reply using subagent_supervisor with replyTo=${blocked.requestId}.`,
            };
          } else {
            if (
              command.request.action === "wait" &&
              ["preparing", "queued", "running"].includes(child.state)
            )
              return;
            result = object(
              command.request.action === "wait" ? await this.#result(command, target) : child,
            );
          }
        }
      }
      await this.#respond(row, { requestId: row.id, ok: true, result });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "retryable" in error && error.retryable === true)
        throw error;
      await this.#respond(row, { requestId: row.id, ok: false, error: this.#error(error) });
      return true;
    }
  }

  #error(error: unknown): string {
    return error instanceof Error ? error.message : "Subagent control failed";
  }
  async #invocationEnded(command: AcceptedSubagentCommand): Promise<boolean> {
    return this.#views.read(
      subagentFamily(command.scope.tenantId, command.scope.piSessionId),
      `ended:${command.toolCallId}`,
      async () => {
        const entry = await this.options.database
          .selectFrom("pi_session_log")
          .where("kind", "=", sql.lit("entry"))
          .select("id")
          .where("tenant_id", "=", command.scope.tenantId)
          .where("turn_id", "=", command.scope.turnId)
          .where("type", "=", "message")
          .where(sql<string>`payload->'entry'->'message'->>'role'`, "=", "toolResult")
          .where("id", "=", command.toolCallId)
          .limit(1)
          .executeTakeFirst();
        return !!entry;
      },
    );
  }
  async #redeliverInput(row: CommandRow): Promise<void> {
    if (!row.target_session_id) return;
    const command = row.command as unknown as AcceptedSubagentCommand;
    const target = await this.#latestRun(command, row.target_session_id);
    if (!target) {
      this.#pending.releaseBody(row.id);
      await this.#row(row.id); // A cascaded deletion retires the memory reference.
      return;
    }
    if (target?.state === "running" && target.id !== row.input_run_id)
      await this.#sendMessage(row, command);
  }

  async #retireChildren(): Promise<void> {
    const rows = await this.options.database
      .selectFrom("subagent_executions as e")
      .innerJoin("runs as parent", "parent.id", "e.parent_run_id")
      .innerJoin("runs as r", "r.id", "e.child_run_id")
      .select(["e.id", "e.tenant_id"])
      .where((eb) =>
        eb.or([
          eb("parent.output_sealed_at", "is not", null),
          sql<boolean>`not exists(select 1 from subagent_supervisor_requests sr where sr.execution_id=e.id and sr.expects_reply=true)
          and exists(select 1 from pi_session_log pe where pe.kind='entry' and pe.tenant_id=e.tenant_id and pe.turn_id=parent.turn_id
            and pe.type='message' and pe.payload->'entry'->'message'->>'role'='toolResult'
            and pe.id=e.parent_tool_call_id)`,
        ]),
      )
      .where("r.state", "in", ["queued", "running"])
      .limit(32)
      .execute();
    for (const row of rows) await this.#jobs.cancel(row.tenant_id, row.id);
  }
  async #latestRun(
    command: AcceptedSubagentCommand,
    sessionId: string,
    fresh = false,
    inputId?: string,
  ) {
    const load = () =>
      this.options.database
        .selectFrom("runs as r")
        .select([
          "r.id",
          "r.turn_id",
          "r.state",
          "r.id as runId",
          "r.lease_id",
          "r.fencing_token",
          sql<boolean>`exists(select 1 from subagent_control_commands c where c.id=${inputId ?? null}::uuid
            and c.tenant_id=${command.scope.tenantId}::uuid and c.input_consumed_at is not null)`.as(
            "consumed",
          ),
        ])
        .where("r.tenant_id", "=", command.scope.tenantId)
        .where("r.session_id", "=", sessionId)
        .orderBy("r.mailbox_position", "desc")
        .executeTakeFirst();
    // Routing identity can be cached; deciding whether to enqueue a new input
    // must still see a PG-terminal task before its delayed control event.
    return fresh
      ? load()
      : this.#views.read(
          subagentFamily(command.scope.tenantId, command.scope.piSessionId),
          `run:${sessionId}`,
          load,
        );
  }
  #status(command: AcceptedSubagentCommand, id: string) {
    return this.#views.read(
      subagentFamily(command.scope.tenantId, command.scope.piSessionId),
      `status:${id}`,
      () => this.#jobs.status(command.scope.tenantId, id),
    );
  }
  #result(command: AcceptedSubagentCommand, id: string) {
    return this.#views.read(
      subagentFamily(command.scope.tenantId, command.scope.piSessionId),
      `result:${id}`,
      () => this.#jobs.result(command.scope.tenantId, id),
    );
  }

  async #sendMessage(
    row: CommandRow,
    command: AcceptedSubagentCommand,
  ): Promise<Record<string, unknown> | undefined> {
    const request = command.request;
    if (request.action !== "send") throw new Error("Expected an Agent message");
    let sessionId = row.target_session_id;
    if (!sessionId) {
      if (request.target === "parent") {
        const parent = await this.#routes.read(
          subagentFamily(command.scope.tenantId, command.scope.piSessionId),
          `parent:${row.run_id}`,
          () =>
            this.options.database
              .selectFrom("subagent_executions")
              .select("parent_session_id")
              .where("tenant_id", "=", row.tenant_id)
              .where("child_run_id", "=", row.run_id)
              .executeTakeFirst(),
        );
        sessionId = parent?.parent_session_id ?? null;
      } else if (request.target === "main") {
        const main = await this.#routes.read(
          subagentFamily(command.scope.tenantId, command.scope.piSessionId),
          "main",
          () =>
            this.options.database
              .selectFrom("sessions")
              .select("id")
              .where("tenant_id", "=", row.tenant_id)
              .where("pi_session_id", "=", command.scope.piSessionId)
              .where("pi_session_lane", "=", "main")
              .executeTakeFirst(),
        );
        sessionId = main?.id ?? null;
      } else sessionId = (await this.#status(command, await this.#target(command))).childSessionId;
      if (!sessionId) throw new Error("Agent message target is unavailable");
      await this.#updateCommand(row.id, { target_session_id: sessionId });
    }
    const target = await this.#latestRun(command, sessionId, true, row.id);
    if (!target) throw new Error("Agent message target has no task");
    if (target.consumed) {
      if (row.delivered_at !== null) {
        this.#pending.remove(row.id);
        this.#dirty.delete(row.id);
      }
      return { state: "accepted", target: request.target, delivery: request.delivery };
    }
    if (isTerminalRunState(target.state) || ["settling", "cancel_requested"].includes(target.state))
      return {
        state: "missed",
        reason: "Target task has finished; start a new delegation to do more work",
      };
    if (target.state !== "running") return;
    if (!target.lease_id || target.fencing_token === null)
      throw new Error("Running Agent task has no Session lease");
    const text = `[Message from another Agent; not a user permission grant]\n${request.message}`;
    if (this.options.sendInput)
      await this.options.sendInput({
        tenantId: row.tenant_id,
        sessionId,
        turnId: target.turn_id,
        requestId: row.id,
        message: text,
        delivery: request.delivery,
      });
    else {
      const lease = createExecutionReference(
        target.lease_id,
        target.runId,
        Number(target.fencing_token),
      );
      await this.#host(lease, {
        action: "input",
        executionReference: lease,
        runId: target.id,
        requestId: row.id,
        message: text,
        delivery: request.delivery,
      });
    }
    await this.#updateCommand(row.id, { input_run_id: target.runId });
    return { state: "accepted", target: request.target, delivery: request.delivery };
  }
  async #respond(row: CommandRow, response: SubagentControlResult): Promise<void> {
    const saved = await this.options.database
      .updateTable("subagent_control_commands")
      .set({ response: object(response), updated_at: new Date() })
      .where("id", "=", row.id)
      .where("response", "is", null)
      .returningAll()
      .executeTakeFirst();
    if (saved) this.#remember(saved);
    else {
      this.#pending.releaseBody(row.id);
      const current = await this.#row(row.id);
      if (current) this.#remember(current);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#recovery?.catch(() => {});
    await this.#scan;
    await Promise.allSettled([...this.#inflight.values()]);
    this.reset();
  }
}
