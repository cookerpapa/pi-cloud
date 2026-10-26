import { receivingConversationRunId } from "@pi-cloud/runtime-core/run-readiness";
import type { Database } from "@pi-cloud/database";
import type { Kysely, Selectable } from "kysely";
import { readNativeCompaction } from "@pi-cloud/pi-session-postgres/durable";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import {
  parseExecutionReference,
  type CompactRequest,
  type ConversationCompactResource,
  type NativeCompactResult,
} from "@pi-cloud/protocol";
import type { NativeInputBackendFactory } from "./queued-input-service.ts";
import type { ControlPlaneStore } from "./control-plane-store.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import {
  compactCommandId,
  compactFingerprint,
  compactRunState,
} from "./conversation-command-identity.ts";

const runFields = [
  "id",
  "turn_id",
  "mailbox_position",
  "state",
  "operation_kind",
  "stop_reason",
  "created_at",
  "worker_id",
  "lease_id",
  "output_sealed_at",
  "project_id",
  "workspace_id",
] as const;
type Run = Pick<Selectable<Database["runs"]>, (typeof runFields)[number]>;
const terminal = (run: Run) =>
  ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
const unavailable = () =>
  new ControlPlaneStoreError(
    "input_delivery_unavailable",
    "The Agent cannot confirm compaction yet; keep the command and retry",
  );

export class ConversationCompactService {
  constructor(
    readonly options: { database: Kysely<Database>; backendFactory?: NativeInputBackendFactory },
  ) {}
  async get(
    tenantId: string,
    sessionId: string,
    commandId?: string,
  ): Promise<ConversationCompactResource | null> {
    return this.options.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (db) => {
        const session = await db
          .selectFrom("sessions")
          .select(["pi_session_id", "pi_conversation_id"])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .where("pruned_at", "is", null)
          .executeTakeFirst();
        if (!session) throw new ControlPlaneStoreError("not_found", "Conversation was not found");
        const native =
          session.pi_conversation_id === null
            ? undefined
            : await readNativeCompaction(
                db,
                {
                  tenantId,
                  sessionId: session.pi_session_id,
                  conversationId: Number(session.pi_conversation_id),
                },
                commandId,
              );
        const nativeRun = native
          ? await db
              .selectFrom("runs")
              .select(runFields)
              .where("tenant_id", "=", tenantId)
              .where("id", "=", native.runId)
              .executeTakeFirst()
          : undefined;
        const cold = await db
          .selectFrom("runs")
          .select(runFields)
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("operation_kind", "=", "compact")
          .$if(commandId !== undefined, (q) => q.where("turn_id", "=", commandId!))
          .orderBy("mailbox_position", "desc")
          .limit(1)
          .executeTakeFirst();
        if (
          cold &&
          (!nativeRun || BigInt(cold.mailbox_position) > BigInt(nativeRun.mailbox_position))
        )
          return {
            commandId: cold.turn_id,
            initialOperation: true,
            sessionId,
            runId: cold.id,
            turnId: cold.turn_id,
            state: compactRunState(cold.state, cold.stop_reason),
            acceptedAt: new Date(cold.created_at).toISOString(),
            nativeSequence: 0,
            replayed: false,
          };
        if (!native || !nativeRun) return null;
        return {
          commandId: native.requestId,
          initialOperation: nativeRun.operation_kind === "compact",
          sessionId,
          runId: nativeRun.id,
          turnId: nativeRun.turn_id,
          state: native.state,
          acceptedAt: native.requestedAt,
          nativeSequence: native.nativeSequence,
          replayed: false,
        };
      });
  }
  async accept(
    store: ControlPlaneStore,
    tenantId: string,
    sessionId: string,
    key: string,
    request: CompactRequest,
  ): Promise<ConversationCompactResource> {
    const commandId = compactCommandId(tenantId, sessionId, key),
      instructions = request.instructions ?? "",
      fingerprint = compactFingerprint(instructions);
    const decision = await store.withWorkAdmission(
      sessionId,
      key,
      { kind: "compact", commandId, instructions },
      async ({ transaction: db, session, hasAcceptedRun, acceptInitial }) => {
        if (hasAcceptedRun) return { cold: await acceptInitial() };
        if (session.pi_conversation_id !== null) {
          const native = await readNativeCompaction(
            db,
            {
              tenantId,
              sessionId: session.pi_session_id,
              conversationId: Number(session.pi_conversation_id),
            },
            commandId,
          );
          if (native) {
            if (native.fingerprint !== fingerprint)
              throw new ControlPlaneStoreError(
                "idempotency_conflict",
                "Compact identity was used for different instructions",
              );
            return { replay: true };
          }
        }
        const target = await db
          .selectFrom("runs")
          .select(runFields)
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("id", "=", receivingConversationRunId(tenantId, sessionId))
          .limit(1)
          .executeTakeFirst();
        if (
          !target ||
          (terminal(target) && (target.lease_id === null || target.output_sealed_at !== null))
        )
          return { cold: await acceptInitial() };
        if (target.operation_kind === "compact")
          throw new ControlPlaneStoreError("conflict", "A compaction is already in progress");
        if (target.state !== "running" || !target.worker_id || !target.lease_id)
          throw unavailable();
        const stop = await db
          .selectFrom("turn_control_requests")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("target_run_id", "=", target.id)
          .where("kind", "=", "cancel")
          .where("state", "in", ["pending", "dispatched", "acknowledged"])
          .limit(1)
          .executeTakeFirst();
        if (stop) throw new ControlPlaneStoreError("conflict", "The Agent is stopping");
        return { target };
      },
    );
    if (decision.cold || decision.replay) {
      const resource = await this.get(tenantId, sessionId, commandId);
      if (!resource) throw unavailable();
      return { ...resource, replayed: decision.replay ?? decision.cold!.replayed };
    }
    const target = decision.target!;
    const factory = this.options.backendFactory;
    if (!factory || !target.worker_id) throw unavailable();
    let result: NativeCompactResult;
    try {
      const grant = await new SessionLeaseCoordinator({
        database: this.options.database,
        workerId: target.worker_id,
      }).currentAssignment({
        tenantId,
        sessionId,
        runId: target.id,
        turnId: target.turn_id,
        projectId: target.project_id,
        workspaceId: target.workspace_id,
      });
      if (parseExecutionReference(grant.executionReference).leaseId !== target.lease_id)
        throw unavailable();
      const backend = await factory(target.worker_id);
      if (!backend.compact) throw unavailable();
      result = await backend.compact({
        tenantId,
        sessionId,
        runId: target.id,
        executionReference: grant.executionReference,
        commandId,
        fingerprint,
        requestedAt: new Date().toISOString(),
        ...(instructions ? { instructions } : {}),
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "idempotency_conflict")
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Compact identity was used for different instructions",
        );
      if (code === "compaction_busy")
        throw new ControlPlaneStoreError("conflict", "A compaction is already in progress");
      throw unavailable();
    }
    if (result.commandId !== commandId || result.taskId < 1 || result.nativeSequence < 1)
      throw unavailable();
    return {
      commandId,
      initialOperation: false,
      sessionId,
      runId: target.id,
      turnId: target.turn_id,
      state: result.state,
      acceptedAt: result.requestedAt,
      nativeSequence: result.nativeSequence,
      replayed: result.replayed,
    };
  }
}
