import type { Database } from "@pi-cloud/database";
import type {
  ConversationDetailResource,
  ConversationListResource,
  ConversationTurnState,
  ProjectEnvironmentResource,
} from "@pi-cloud/protocol";
import { parseEnvironmentValidationReport } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { readCanonicalPiTurnTranscripts } from "@pi-cloud/runtime-core/canonical-pi-conversation";
import { loadDelegatedSessionTreeSummaries } from "./delegated-session-projection.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import {
  environmentSnapshot,
  workspaceSourceResource,
  isoTimestamp,
  positiveSafeInteger,
  nonNegativeSafeInteger,
} from "./store-resource-mapping.ts";
type ConversationLineageNode = {
  sessionId: string;
  parentSessionId: string | null;
  forkTurnId: string | null;
};

type ConversationHistoryRow = {
  originSessionId: string;
  runId: string;
  turnId: string;
  inputKind: string;
  prompt: string | null;
  turnState: ConversationTurnState;
  waitingForSeal: boolean;
  mailboxPosition: string | null;
  acceptedAt: Date | string;
};

const MAX_CONVERSATION_SUMMARIES = 100;
const MAX_DELEGATED_SESSION_SUMMARIES = 500;
const MAX_CONVERSATION_TURNS = 40;
const MAX_INHERITED_MESSAGES = 10_000;
/** Tenant-scoped read model. A snapshot and its coverage share one PG transaction;
 * this reader cannot admit Runs, change resource ownership, or allocate native IDs. */
export class ConversationReader {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  constructor(database: Kysely<Database>, tenantId: string) {
    this.#database = database;
    this.#tenantId = tenantId;
  }
  async listConversations(): Promise<ConversationListResource> {
    const rows = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .leftJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "session_row.tenant_id")
          .onRef("turn.session_id", "=", "session_row.id")
          .on("turn.pruned_at", "is", null),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.title as title",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.development_environment_id as developmentEnvironmentId",
        "session_row.state as state",
        "session_row.execution_mode as executionMode",
        "session_row.sandbox_profile_key as sandboxProfileKey",
        "session_row.working_directory as workingDirectory",
        "session_row.created_at as createdAt",
        "session_row.updated_at as updatedAt",
        "session_row.last_active_at as lastActiveAt",
        "session_row.conversation_parent_session_id as parentSessionId",
        "project.name as workspaceName",
        "workspace.deleted_at as workspaceDeletedAt",
      ])
      .select((expression) => expression.fn.count<string>("turn.id").as("turnCount"))
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.session_kind", "=", "conversation")
      .where("session_row.archived_at", "is", null)
      .groupBy([
        "session_row.id",
        "session_row.title",
        "session_row.project_id",
        "session_row.workspace_id",
        "session_row.development_environment_id",
        "session_row.state",
        "session_row.execution_mode",
        "session_row.sandbox_profile_key",
        "session_row.working_directory",
        "session_row.created_at",
        "session_row.updated_at",
        "session_row.last_active_at",
        "session_row.conversation_parent_session_id",
        "project.name",
        "workspace.deleted_at",
      ])
      .orderBy("session_row.last_active_at", "desc")
      .orderBy("session_row.id", "desc")
      .limit(MAX_CONVERSATION_SUMMARIES + 1)
      .execute();
    const visibleRows = rows.slice(0, MAX_CONVERSATION_SUMMARIES);
    const delegated = await loadDelegatedSessionTreeSummaries(this.#database, {
      tenantId: this.#tenantId,
      rootParentSessionIds: visibleRows.map((row) => row.sessionId),
      maximum: MAX_DELEGATED_SESSION_SUMMARIES,
    });
    return {
      conversations: visibleRows.map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        ...(row.developmentEnvironmentId === null
          ? {}
          : { developmentEnvironmentId: row.developmentEnvironmentId }),
        workspaceName: row.workspaceName,
        workspaceState: row.workspaceDeletedAt === null ? "attached" : "missing",
        state: row.state,
        executionMode: row.executionMode,
        sandboxProfileKey: row.sandboxProfileKey,
        workingDirectory: row.workingDirectory,
        turnCount: nonNegativeSafeInteger(row.turnCount, "Conversation turn count"),
        createdAt: isoTimestamp(row.createdAt),
        updatedAt: isoTimestamp(row.updatedAt),
        lastActiveAt: isoTimestamp(row.lastActiveAt),
        ...(row.parentSessionId === null ? {} : { parentSessionId: row.parentSessionId }),
      })),
      delegatedSessions: delegated.items,
      truncated: rows.length > MAX_CONVERSATION_SUMMARIES || delegated.truncated,
    };
  }

  async getConversation(
    sessionId: string,
    beforeTurnId?: string,
  ): Promise<ConversationDetailResource> {
    return (await this.getConversationView(sessionId, beforeTurnId)).conversation;
  }

  async getConversationView(
    sessionId: string,
    beforeTurnId?: string,
  ): Promise<{
    conversation: ConversationDetailResource;
    canonicalThroughSequence: number;
  }> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((transaction) => {
        const reader = new ConversationReader(transaction, this.#tenantId);
        return reader.#readConversation(sessionId, beforeTurnId);
      });
  }

  async #readConversation(
    sessionId: string,
    beforeTurnId?: string,
  ): Promise<{
    conversation: ConversationDetailResource;
    canonicalThroughSequence: number;
  }> {
    const conversation = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.session_kind as sessionKind",
        "session_row.title as sessionTitle",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.development_environment_id as developmentEnvironmentId",
        "session_row.desired_model_profile_id as modelProfileId",
        "session_row.state as sessionState",
        "session_row.execution_mode as executionMode",
        "session_row.sandbox_profile_key as sandboxProfileKey",
        "session_row.working_directory as workingDirectory",
        "session_row.created_at as sessionCreatedAt",
        "session_row.updated_at as sessionUpdatedAt",
        "session_row.last_active_at as lastActiveAt",
        "session_row.conversation_parent_session_id as parentSessionId",
        "project.name as projectName",
        "project.created_at as projectCreatedAt",
        "workspace.deleted_at as workspaceDeletedAt",
        "workspace.seed_kind as workspaceSeedKind",
        "session_row.next_event_seq as nextEventSequence",
      ])
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.id", "=", sessionId)
      .where("session_row.archived_at", "is", null)
      .executeTakeFirst();
    if (conversation === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }

    const lineage =
      conversation.sessionKind === "conversation"
        ? await this.#conversationLineage(sessionId)
        : [{ sessionId, parentSessionId: null, forkTurnId: null }];
    const lineageTurnRows: ConversationHistoryRow[] = [];
    const anchor =
      beforeTurnId === undefined
        ? undefined
        : await this.#database
            .selectFrom("runs as anchor")
            .innerJoin("turns as anchor_turn", "anchor_turn.id", "anchor.turn_id")
            .select(["anchor.session_id", "anchor.mailbox_position"])
            .where("anchor.tenant_id", "=", this.#tenantId)
            .where("anchor.turn_id", "=", beforeTurnId)
            .where("anchor_turn.pruned_at", "is", null)
            .executeTakeFirst();
    if (
      beforeTurnId !== undefined &&
      (!anchor || !lineage.some((node) => node.sessionId === anchor.session_id))
    )
      throw new ControlPlaneStoreError("not_found", "History anchor is not in this conversation");
    let reachedAnchor = anchor === undefined;
    for (let index = lineage.length - 1; index >= 0; index -= 1) {
      const node = lineage[index]!;
      if (!reachedAnchor) {
        if (node.sessionId !== anchor!.session_id) continue;
        reachedAnchor = true;
      }
      const child = lineage[index + 1];
      const forkMailboxPosition =
        child?.forkTurnId === null || child?.forkTurnId === undefined
          ? null
          : await this.#database
              .selectFrom("runs")
              .select("mailbox_position")
              .where("tenant_id", "=", this.#tenantId)
              .where("session_id", "=", node.sessionId)
              .where("turn_id", "=", child.forkTurnId)
              .executeTakeFirst();
      if (
        child?.forkTurnId !== null &&
        child?.forkTurnId !== undefined &&
        forkMailboxPosition === undefined
      ) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation fork Turn is missing from its parent Session",
        );
      }
      if (
        anchor?.session_id === node.sessionId &&
        forkMailboxPosition &&
        BigInt(anchor.mailbox_position) > BigInt(forkMailboxPosition.mailbox_position)
      )
        throw new ControlPlaneStoreError(
          "not_found",
          "History anchor is beyond the conversation fork",
        );
      const newestRows = await this.#database
        .selectFrom("runs as run")
        .innerJoin("turns as turn", (join) =>
          join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
        )
        .leftJoin("run_attempts as view_attempt", "view_attempt.id", "run.current_attempt_id")
        .select([
          "run.session_id as originSessionId",
          "run.id as runId",
          "turn.id as turnId",
          "turn.input_kind as inputKind",
          "turn.input_text as prompt",
          "turn.state as turnState",
          sql<boolean>`(view_attempt.output_seal_id is not null and view_attempt.output_sealed_at is null)`.as(
            "waitingForSeal",
          ),
          "run.mailbox_position as mailboxPosition",
          "run.created_at as acceptedAt",
        ])
        .where("run.tenant_id", "=", this.#tenantId)
        .where("run.session_id", "=", node.sessionId)
        .where("turn.pruned_at", "is", null)
        .where("run.mailbox_position", "is not", null)
        .$if(anchor?.session_id === node.sessionId, (query) =>
          query.where("run.mailbox_position", "<", anchor!.mailbox_position),
        )
        .$if(forkMailboxPosition !== null && forkMailboxPosition !== undefined, (query) =>
          query.where("run.mailbox_position", "<=", forkMailboxPosition!.mailbox_position!),
        )
        .orderBy("run.mailbox_position", "desc")
        .orderBy("run.id", "desc")
        .limit(MAX_CONVERSATION_TURNS + 1 - lineageTurnRows.length)
        .execute();
      lineageTurnRows.push(...newestRows);
      if (lineageTurnRows.length > MAX_CONVERSATION_TURNS) break;
    }
    const historyTruncated = lineageTurnRows.length > MAX_CONVERSATION_TURNS;
    const includedRows = lineageTurnRows.slice(0, MAX_CONVERSATION_TURNS).reverse();
    const turnIds = includedRows.map((row) => row.turnId);
    const transcriptByTurnId = await readCanonicalPiTurnTranscripts(this.#database, {
      tenantId: this.#tenantId,
      turnIds,
    });
    const turns = includedRows.map((row) => {
      if (row.inputKind !== "prompt" || row.prompt === null || row.mailboxPosition === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation contains an invalid prompt turn",
        );
      }
      return {
        runId: row.runId,
        turnId: row.turnId,
        mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Conversation mailbox position"),
        prompt: row.prompt,
        state:
          row.waitingForSeal &&
          (row.turnState === "completed" ||
            row.turnState === "failed" ||
            row.turnState === "cancelled") &&
          transcriptByTurnId.get(row.turnId)?.terminalSequence == null
            ? ("running" as const)
            : row.turnState,
        ...(transcriptByTurnId.has(row.turnId)
          ? { transcript: transcriptByTurnId.get(row.turnId)! }
          : {}),
        acceptedAt: isoTimestamp(row.acceptedAt),
        originSessionId: row.originSessionId,
      };
    });

    const canonicalThroughSequence = Math.max(
      nonNegativeSafeInteger(conversation.nextEventSequence, "Conversation next event sequence") -
        1,
      ...includedRows
        .filter((row) => row.originSessionId === sessionId)
        .map((row) => transcriptByTurnId.get(row.turnId)?.throughSequence ?? 0),
    );
    const environment = await this.#loadActiveProjectEnvironment(conversation.projectId);
    const inheritedMessages =
      conversation.sessionKind === "subagent" && beforeTurnId === undefined
        ? await this.#delegatedInheritedMessages(sessionId)
        : [];
    return {
      canonicalThroughSequence,
      conversation: {
        project: {
          projectId: conversation.projectId,
          workspaceId: conversation.workspaceId,
          name: conversation.projectName,
          createdAt: isoTimestamp(conversation.projectCreatedAt),
          source: workspaceSourceResource(conversation.workspaceSeedKind),
          environment,
        },
        session: {
          sessionId: conversation.sessionId,
          title: conversation.sessionTitle,
          projectId: conversation.projectId,
          workspaceId: conversation.workspaceId,
          ...(conversation.developmentEnvironmentId === null
            ? {}
            : { developmentEnvironmentId: conversation.developmentEnvironmentId }),
          workspaceState: conversation.workspaceDeletedAt === null ? "attached" : "missing",
          state: conversation.sessionState,
          executionMode: conversation.executionMode,
          sandboxProfileKey: conversation.sandboxProfileKey,
          workingDirectory: conversation.workingDirectory,
          modelProfileId: conversation.modelProfileId,
          createdAt: isoTimestamp(conversation.sessionCreatedAt),
          updatedAt: isoTimestamp(conversation.sessionUpdatedAt),
          lastActiveAt: isoTimestamp(conversation.lastActiveAt),
          ...(conversation.parentSessionId === null
            ? {}
            : { parentSessionId: conversation.parentSessionId }),
        },
        inheritedMessages,
        turns,
        historyTruncated,
      },
    };
  }

  async #delegatedInheritedMessages(
    sessionId: string,
  ): Promise<ConversationDetailResource["inheritedMessages"]> {
    const execution = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("sessions as child", (join) =>
        join
          .onRef("child.tenant_id", "=", "execution.tenant_id")
          .onRef("child.id", "=", "execution.child_session_id"),
      )
      .select([
        "execution.context_mode as contextMode",
        "execution.pi_context_base_entry_id as contextBaseEntryId",
        "child.pi_session_id as piSessionId",
      ])
      .where("execution.tenant_id", "=", this.#tenantId)
      .where("execution.child_session_id", "=", sessionId)
      .executeTakeFirst();
    if (execution === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Delegated Session has no execution record",
      );
    }
    if (execution.contextMode !== "branch") return [];
    if (execution.contextBaseEntryId === null) return [];
    const rows = (
      await sql<{ id: string; timestampMs: string; payload: Record<string, unknown> }>`
        with recursive branch as (
          select id, parent_id, seq, type, timestamp_ms, payload
            from pi_session_visible_entries
           where tenant_id = ${this.#tenantId}::uuid
             and session_id = ${execution.piSessionId}
             and id = ${execution.contextBaseEntryId}
          union all
          select parent.id,
                 parent.parent_id,
                 parent.seq,
                 parent.type,
                 parent.timestamp_ms,
                 parent.payload
            from pi_session_visible_entries parent
            join branch child on child.parent_id = parent.id
           where parent.tenant_id = ${this.#tenantId}::uuid
             and parent.session_id = ${execution.piSessionId}
        )
        select id, timestamp_ms as "timestampMs", payload
         from branch
         where type = 'message'
         order by seq asc
         limit ${MAX_INHERITED_MESSAGES + 1}
      `.execute(this.#database)
    ).rows;
    if (rows.length > MAX_INHERITED_MESSAGES) {
      throw new ControlPlaneStoreError("invalid_request", "Inherited conversation is too large");
    }
    return rows.flatMap((row) => {
      const message = row.payload.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
      const candidate = message as Record<string, unknown>;
      if (candidate.role !== "user" && candidate.role !== "assistant") return [];
      if (
        candidate.role === "assistant" &&
        (typeof candidate.stopReason !== "string" ||
          ["toolUse", "error", "aborted", "pending"].includes(candidate.stopReason))
      ) {
        return [];
      }
      const text =
        typeof candidate.content === "string"
          ? candidate.content
          : Array.isArray(candidate.content)
            ? candidate.content
                .flatMap((part) => {
                  if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
                  const content = part as Record<string, unknown>;
                  return content.type === "text" && typeof content.text === "string"
                    ? [content.text]
                    : [];
                })
                .join("\n")
            : "";
      if (text.length === 0) return [];
      const createdAt = new Date(Number(row.timestampMs));
      if (Number.isNaN(createdAt.valueOf())) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Inherited Pi message timestamp is invalid",
        );
      }
      return [
        {
          entryId: row.id,
          role: candidate.role,
          text,
          createdAt: createdAt.toISOString(),
        },
      ];
    });
  }

  async #conversationLineage(sessionId: string): Promise<ConversationLineageNode[]> {
    const lineage: ConversationLineageNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = sessionId;
    while (cursor !== null) {
      if (seen.has(cursor) || lineage.length >= 100) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation lineage is invalid or too deep",
        );
      }
      seen.add(cursor);
      const row = await this.#database
        .selectFrom("sessions")
        .select([
          "id as sessionId",
          "conversation_parent_session_id as parentSessionId",
          "conversation_fork_turn_id as forkTurnId",
        ])
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", cursor)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      lineage.push(row);
      cursor = row.parentSessionId;
    }
    return lineage.reverse();
  }

  async #loadActiveProjectEnvironment(projectId: string): Promise<ProjectEnvironmentResource> {
    const row = await this.#database
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.active", "=", true)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment version",
      );
    }
    const snapshot = environmentSnapshot(row);
    const validation = await this.#database
      .selectFrom("environment_validations")
      .select(["report", "validated_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("project_id", "=", projectId)
      .where("environment_version_id", "=", snapshot.environmentVersionId)
      .where("status", "=", "validated")
      .orderBy("validated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    let latestValidation;
    if (validation?.report !== null && validation?.report !== undefined) {
      try {
        latestValidation = parseEnvironmentValidationReport(validation.report);
      } catch {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Project environment validation evidence is invalid",
        );
      }
    }
    if (row.environmentState === "validated" && latestValidation === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Validated project environment has no evidence",
      );
    }
    return {
      ...snapshot,
      state: row.environmentState,
      active: row.environmentActive,
      createdAt: isoTimestamp(row.environmentCreatedAt),
      ...(row.environmentValidatedAt === null
        ? {}
        : { validatedAt: isoTimestamp(row.environmentValidatedAt) }),
      ...(latestValidation === undefined ? {} : { latestValidation }),
    };
  }
}
