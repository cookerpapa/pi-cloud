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
} from "@pi-cloud/protocol";
import {
  PostgresSubagentJobProvider,
  type StartCloudSubagentJobInput,
  type CloudSubagentTreePolicy,
  type SubagentDirectoryTarget,
} from "@pi-cloud/trusted-tool-runtime/subagent-jobs";
import { PostgresSubagentSupervisorChannel } from "@pi-cloud/trusted-tool-runtime/subagent-supervisor";
import { sql, type Kysely, type Selectable } from "kysely";
import { HttpSupervisorManagementClient } from "./http-supervisor-management.ts";

type CommandRow = Selectable<Database["subagent_control_commands"]>;
const object = (value: unknown) => value as Record<string, unknown>;

/** The consumer admits in order; preparation and result notification run off-stack. */
export class SubagentController {
  readonly #jobs: PostgresSubagentJobProvider;
  readonly #supervisor: PostgresSubagentSupervisorChannel;
  readonly #clients = new Map<string, HttpSupervisorManagementClient>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #deliveryTails = new Map<string, Promise<void>>();
  #closed = false;
  #scan: Promise<void> | undefined;
  #again = false;
  #reapRequested = true;
  #lastReap = 0;
  #scanAfter = "0";
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
    // Outage/rebalance recovery only. Normal completion wakes from projected seals.
    this.#timer = setInterval(() => this.wake(), 1000);
    this.#timer.unref();
  }

  async #host<T = void>(lease: string, request: SubagentHostRequest): Promise<T> {
    if (this.options.deliver) return (await this.options.deliver(lease, request)) as T;
    const identity = parseExecutionReference(lease);
    const route = await this.options.database
      .selectFrom("run_attempts as a")
      .innerJoin("sandboxes as s", "s.id", "a.sandbox_id")
      .innerJoin("supervisor_hosts as h", "h.supervisor_id", "s.supervisor_id")
      .select("h.management_base_url")
      .where("a.id", "=", identity.attemptId)
      .where("a.lease_id", "=", identity.leaseId)
      .where("a.fencing_token", "=", String(identity.fencingToken))
      .executeTakeFirst();
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
    return (await client.subagent(request)) as T;
  }

  async consume(record: KafkaAcceptedFactRecord, current?: () => boolean): Promise<void> {
    if (current?.() === false || this.#closed) return;
    if (record.fact.kind === "subagent_command") {
      const command = record.fact;
      await this.options.database
        .insertInto("subagent_control_commands")
        .values({
          id: command.factId,
          tenant_id: command.scope.tenantId,
          run_id: command.scope.runId,
          attempt_id: command.scope.attemptId,
          partition: record.partition,
          command: object(command),
          delivered_at: null,
          input_consumed_at: null,
        })
        .onConflict((c) => c.column("id").doNothing())
        .execute();
      const row = await this.options.database
        .selectFrom("subagent_control_commands")
        .selectAll()
        .where("id", "=", command.factId)
        .executeTakeFirstOrThrow();
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
          await this.options.database
            .updateTable("subagent_control_commands")
            .set({ child_execution_id: child.executionId })
            .where("id", "=", row.id)
            .execute();
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
          await this.options.database
            .updateTable("subagent_control_commands")
            .set({
              supervisor_request_id: request.requestId,
              child_execution_id: request.executionId,
            })
            .where("id", "=", row.id)
            .execute();
        } catch (error) {
          await this.#respond(row, { requestId: row.id, ok: false, error: this.#error(error) });
        }
      }
    }
    if (record.fact.kind === "pi_session_append") {
      for (const item of record.fact.items) {
        if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          item.entry.message.role === "user"
        ) {
          // The native prompt proves startup reached the Agent; retry inputs
          // queued while its Run was provisioning/restoring without a timer tick.
          this.wake();
        }
        if (
          item.kind === "entry" &&
          item.entry.type === "message" &&
          item.entry.message.role === "toolResult" &&
          item.entry.message.toolName === "subagent"
        ) {
          this.#reapRequested = true;
          this.wake();
        }
        if (item.kind === "entry" && item.entry.id.startsWith("pc-agent-input-")) {
          await this.options.database
            .updateTable("subagent_control_commands")
            .set({ input_consumed_at: new Date() })
            .where("id", "=", item.entry.id.slice("pc-agent-input-".length))
            .where("tenant_id", "=", record.fact.scope.tenantId)
            .where("target_session_id", "=", record.fact.scope.sessionId)
            .execute();
        }
      }
    }
    if (record.fact.kind === "execution_seal") this.#reapRequested = true;
    if (["subagent_command", "execution_seal"].includes(record.fact.kind)) this.wake();
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
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.#scan = undefined;
        if (this.#again) {
          this.#again = false;
          this.wake();
        }
      });
  }

  async #drain(): Promise<void> {
    await this.#redeliverInputs();
    if (this.#reapRequested || Date.now() - this.#lastReap > 60_000) {
      this.#reapRequested = false;
      this.#lastReap = Date.now();
      // A dead parent cannot poll its child result. Reconcile terminal child
      // Runs on seals/startup too, so resource cleanup never depends on a reader.
      await this.#jobs.reapStalePreparations();
      await this.#retireChildren();
    }
    const available = 128 - this.#inflight.size;
    if (available <= 0) return;
    const rows = await this.options.database
      .selectFrom("subagent_control_commands as c")
      .leftJoin("subagent_executions as e", "e.id", "c.child_execution_id")
      .leftJoin("runs as r", "r.id", "e.child_run_id")
      .innerJoin("run_attempts as a", "a.id", "c.attempt_id")
      .selectAll("c")
      .where("c.delivered_at", "is", null)
      .where("c.ordinal", ">", this.#scanAfter)
      .where((eb) =>
        eb.or([
          eb("c.response", "is not", null),
          eb("a.output_sealed_at", "is not", null),
          eb(sql<string>`c.command->'request'->>'action'`, "!=", "wait"),
          eb("c.child_execution_id", "is", null),
          eb("r.state", "in", ["completed", "failed", "cancelled", "timed_out", "superseded"]),
          sql<boolean>`exists(select 1 from subagent_supervisor_requests sr where sr.execution_id=c.child_execution_id
          and sr.expects_reply=true and sr.reply_message is null and sr.expires_at > now())`,
        ]),
      )
      .orderBy("c.ordinal", "asc")
      .limit(available)
      .execute();
    // Pending human replies must not pin the first page and starve later
    // starts/messages. The cursor is disposable scan fairness, not authority.
    this.#scanAfter = rows.length === available ? String(rows[rows.length - 1]!.ordinal) : "0";
    if (rows.length === available) this.#again = true;
    for (const row of rows) {
      const command = row.command as unknown as AcceptedSubagentCommand;
      const ordered = ["send", "cancel"].includes(command.request.action);
      this.#schedule(row, () => this.#work(row), ordered ? command.scope.piSessionId : undefined);
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
        changed = (await work()) === true;
      })
      .catch((error) => this.options.onError?.(error))
      .finally(() => {
        this.#inflight.delete(row.id);
        if (changed || this.#scanAfter !== "0") this.wake();
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
  }

  async #work(row: CommandRow): Promise<boolean | void> {
    if (this.#closed || !this.options.ownsPartition(row.partition)) return;
    const command = row.command as unknown as AcceptedSubagentCommand;
    const attempt = await this.options.database
      .selectFrom("run_attempts")
      .select("output_sealed_at")
      .where("id", "=", row.attempt_id)
      .executeTakeFirst();
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
      await this.options.database
        .updateTable("subagent_control_commands")
        .set({ delivered_at: new Date() })
        .where("id", "=", row.id)
        .execute();
      return true;
    }
    if (row.response) {
      await this.#host(command.executionReference, {
        action: "result",
        executionReference: command.executionReference,
        response: row.response as unknown as SubagentControlResult,
      });
      await this.options.database
        .updateTable("subagent_control_commands")
        .set({ delivered_at: new Date() })
        .where("id", "=", row.id)
        .execute();
      return true;
    }
    try {
      let result: Record<string, unknown>;
      if (command.request.action === "start") {
        if (!row.child_execution_id) return;
        let child = await this.#jobs.status(row.tenant_id, row.child_execution_id);
        if (child.state === "preparing")
          child = await this.#jobs.prepareChild(this.#startInput(command, row), child);
        if (child.state === "queued")
          await this.#host(command.executionReference, {
            action: "schedule",
            runId: child.childRunId,
          });
        result = object(child);
      } else if (command.request.action === "contact") {
        if (!row.supervisor_request_id) return;
        const request = await this.#supervisor.request(row.tenant_id, row.supervisor_request_id);
        if (request.expectsReply && request.replyMessage === undefined) {
          if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now())
            throw new Error("Supervisor reply timed out");
          return;
        }
        result = object(request);
      } else if (command.request.action === "supervisor") {
        const input = command.request;
        if (input.operation === "pending")
          result = {
            requests: await this.#supervisor.pendingForParent(
              row.tenant_id,
              command.scope.sessionId,
            ),
          };
        else {
          if (!input.requestId) throw new Error("A supervisor request ID is required");
          const request =
            input.operation === "reply"
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
          if (!row.supervisor_request_id) {
            await this.options.database
              .updateTable("subagent_control_commands")
              .set({
                supervisor_request_id: request.requestId,
                child_execution_id: request.executionId,
              })
              .where("id", "=", row.id)
              .execute();
            this.wake();
          }
          const child = await this.#jobs.status(row.tenant_id, request.executionId);
          if (["queued", "running", "preparing"].includes(child.state)) return;
          result = object(await this.#jobs.result(row.tenant_id, request.executionId));
        }
      } else if (command.request.action === "send") {
        const receipt = await this.#sendMessage(row, command);
        if (!receipt) return;
        result = receipt;
      } else {
        const target = row.child_execution_id ?? (await this.#target(command));
        if (!row.child_execution_id)
          await this.options.database
            .updateTable("subagent_control_commands")
            .set({ child_execution_id: target })
            .where("id", "=", row.id)
            .execute();
        if (command.request.action === "cancel")
          result = object(await this.#jobs.cancel(row.tenant_id, target));
        else {
          const child = await this.#jobs.status(row.tenant_id, target);
          const blocked =
            command.request.action === "wait"
              ? await this.#supervisor.latestForExecution(row.tenant_id, target)
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
              command.request.action === "wait"
                ? await this.#jobs.result(row.tenant_id, target)
                : child,
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
    const entry = await this.options.database
      .selectFrom("pi_session_entries")
      .select("id")
      .where("tenant_id", "=", command.scope.tenantId)
      .where("turn_id", "=", command.scope.turnId)
      .where("type", "=", "message")
      .where(sql<string>`payload->'message'->>'role'`, "=", "toolResult")
      .where(sql<string>`payload->'message'->>'toolCallId'`, "=", command.toolCallId)
      .limit(1)
      .executeTakeFirst();
    return !!entry;
  }
  async #redeliverInputs(): Promise<void> {
    const rows = await this.options.database
      .selectFrom("subagent_control_commands as c")
      .innerJoin("runs as r", "r.session_id", "c.target_session_id")
      .innerJoin("run_attempts as a", "a.id", "r.current_attempt_id")
      .selectAll("c")
      .where("c.input_consumed_at", "is", null)
      .where("c.response", "is not", null)
      .where("r.state", "=", "running")
      .where(sql<string>`c.response->'result'->>'state'`, "=", "accepted")
      .whereRef("c.input_attempt_id", "is distinct from", "a.id")
      .orderBy("c.ordinal", "asc")
      .limit(128)
      .execute();
    for (const row of rows) {
      const command = row.command as unknown as AcceptedSubagentCommand;
      this.#schedule(
        row,
        async () => {
          await this.#sendMessage(row, command);
        },
        command.scope.piSessionId,
      );
    }
  }
  async #retireChildren(): Promise<void> {
    const rows = await this.options.database
      .selectFrom("subagent_executions as e")
      .innerJoin("run_attempts as a", "a.id", "e.parent_attempt_id")
      .innerJoin("runs as parent", "parent.id", "e.parent_run_id")
      .innerJoin("runs as r", "r.id", "e.child_run_id")
      .select(["e.id", "e.tenant_id"])
      .where((eb) =>
        eb.or([
          eb("a.output_sealed_at", "is not", null),
          sql<boolean>`not exists(select 1 from subagent_supervisor_requests sr where sr.execution_id=e.id and sr.expects_reply=true)
          and exists(select 1 from pi_session_entries pe where pe.tenant_id=e.tenant_id and pe.turn_id=parent.turn_id
            and pe.type='message' and pe.payload->'message'->>'role'='toolResult'
            and pe.payload->'message'->>'toolCallId'=e.parent_tool_call_id)`,
        ]),
      )
      .where("r.state", "in", ["queued", "claimed", "provisioning", "restoring", "running"])
      .limit(32)
      .execute();
    for (const row of rows) await this.#jobs.cancel(row.tenant_id, row.id);
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
        const parent = await this.options.database
          .selectFrom("subagent_executions")
          .select("parent_session_id")
          .where("tenant_id", "=", row.tenant_id)
          .where("child_run_id", "=", row.run_id)
          .executeTakeFirst();
        sessionId = parent?.parent_session_id ?? null;
      } else if (request.target === "main") {
        const main = await this.options.database
          .selectFrom("sessions")
          .select("id")
          .where("tenant_id", "=", row.tenant_id)
          .where("pi_session_id", "=", command.scope.piSessionId)
          .where("pi_session_lane", "=", "main")
          .executeTakeFirst();
        sessionId = main?.id ?? null;
      } else
        sessionId = (await this.#jobs.status(row.tenant_id, await this.#target(command)))
          .childSessionId;
      if (!sessionId) throw new Error("Agent message target is unavailable");
      await this.options.database
        .updateTable("subagent_control_commands")
        .set({ target_session_id: sessionId })
        .where("id", "=", row.id)
        .execute();
    }
    const target = await this.options.database
      .selectFrom("runs as r")
      .leftJoin("run_attempts as a", "a.id", "r.current_attempt_id")
      .select([
        "r.id",
        "r.turn_id",
        "r.state",
        "a.id as attemptId",
        "a.lease_id",
        "a.fencing_token",
      ])
      .where("r.tenant_id", "=", row.tenant_id)
      .where("r.session_id", "=", sessionId)
      .orderBy("r.mailbox_position", "desc")
      .executeTakeFirst();
    if (!target) throw new Error("Agent message target has no task");
    if (isTerminalRunState(target.state) || ["settling", "cancel_requested"].includes(target.state))
      return {
        state: "missed",
        reason: "Target task has finished; start a new delegation to do more work",
      };
    if (target.state !== "running") return;
    // Claim becomes running before the Worker finishes binding its authority.
    // That startup interval is pending delivery, not a completed target.
    if (!target.attemptId || !target.lease_id || target.fencing_token === null) return;
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
        target.attemptId,
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
    await this.options.database
      .updateTable("subagent_control_commands")
      .set({ input_attempt_id: target.attemptId })
      .where("id", "=", row.id)
      .execute();
    return { state: "accepted", target: request.target, delivery: request.delivery };
  }
  async #respond(row: CommandRow, response: SubagentControlResult): Promise<void> {
    await this.options.database
      .updateTable("subagent_control_commands")
      .set({ response: object(response), updated_at: new Date() })
      .where("id", "=", row.id)
      .where("response", "is", null)
      .execute();
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#scan;
    await Promise.allSettled([...this.#inflight.values()]);
  }
}
