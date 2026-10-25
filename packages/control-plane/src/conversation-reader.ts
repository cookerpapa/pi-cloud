import { compactRunState } from "./conversation-command-identity.ts";
import { turnStateForRun, type RunState } from "@pi-cloud/domain";
import { readDurableEntries } from "@pi-cloud/pi-session-postgres/durable";
import type { Database } from "@pi-cloud/database";
import type {
  ConversationDetailResource,
  ConversationListResource,
  ProjectEnvironmentResource,
  SessionState,
} from "@pi-cloud/protocol";
import {
  parseEnvironmentValidationReport,
  MAX_INHERITED_CONTEXT_ENTRIES,
} from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { jsonObjectFrom } from "kysely/helpers/postgres";
import { parseUserUploads } from "@pi-cloud/protocol";
import {
  readCanonicalPiTurnTranscripts,
  conversationPrompt,
} from "@pi-cloud/runtime-core/canonical-pi-conversation";
import { loadDelegatedSessionTreeSummaries } from "./delegated-session-projection.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import {
  inheritedContextPreview,
  type InheritedContextPreview,
} from "./inherited-context-preview.ts";
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
  operationKind: "chat" | "compact";
  stopReason: string | null;
  originSessionId: string;
  runId: string;
  turnId: string;
  prompt: string | null;
  uploads: unknown[];
  runState: RunState;
  waitingForSeal: boolean;
  mailboxPosition: string | null;
  acceptedAt: Date | string;
};

const MAX_CONVERSATION_SUMMARIES = 100;
const MAX_DELEGATED_SESSION_SUMMARIES = 500;
const MAX_CONVERSATION_TURNS = 40;

function listPosition(cursor: string | undefined): { at: string; id: string } | undefined {
  if (cursor === undefined) return;
  try {
    if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };
    if (
      typeof value.at !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at) ||
      !Number.isFinite(Date.parse(value.at)) ||
      new Date(value.at).getUTCFullYear() < 1 ||
      new Date(value.at).toISOString() !== value.at.replace(/(\.\d{3})\d{3}Z$/, "$1Z") ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    )
      throw new Error();
    return { at: value.at, id: value.id };
  } catch {
    throw new ControlPlaneStoreError("invalid_request", "Conversation list cursor is invalid");
  }
}
/** Tenant-scoped read model. A snapshot and its coverage share one PG transaction;
 * this reader cannot admit Runs, change resource ownership, or allocate native IDs. */
export class ConversationReader {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  constructor(database: Kysely<Database>, tenantId: string) {
    this.#database = database;
    this.#tenantId = tenantId;
  }
  async listConversations(cursor?: string): Promise<ConversationListResource> {
    const position = listPosition(cursor);
    // Bound the Session page before touching its Turns. History outside this
    // page must not participate in aggregation or sorting.
    const page = this.#database
      .selectFrom("sessions as session_row")
      .selectAll()
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.session_kind", "=", sql.lit("conversation"))
      .where("session_row.pruned_at", "is", null)
      .$if(position !== undefined, (query) =>
        query.where(sql<boolean>`
        (session_row.last_active_at, session_row.id) < (${position!.at}::timestamptz, ${position!.id}::uuid)
      `),
      )
      .orderBy("session_row.last_active_at", "desc")
      .orderBy("session_row.id", "desc")
      .limit(MAX_CONVERSATION_SUMMARIES + 1);
    const rows = await this.#database
      .selectFrom(page.as("session_row"))
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
      .innerJoinLateral(
        (query) =>
          query
            .selectFrom("conversation_turns as counted_run")
            .select((expression) => expression.fn.countAll<string>().as("count"))
            .whereRef("counted_run.tenant_id", "=", "session_row.tenant_id")
            .whereRef("counted_run.session_id", "=", "session_row.id")
            .where("counted_run.pruned_at", "is", null)
            .where("counted_run.state", "!=", "queued")
            .where("counted_run.operation_kind", "=", "chat")
            .where(
              sql<boolean>`not (counted_run.state='cancelled' and counted_run.started_at is null)`,
            )
            .as("turn_count"),
        (join) => join.onTrue(),
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
      .select("turn_count.count as turnCount")
      .select(
        sql<string>`to_char(session_row.last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          "cursorAt",
        ),
      )
      .orderBy("session_row.last_active_at", "desc")
      .orderBy("session_row.id", "desc")
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
      ...(rows.length > MAX_CONVERSATION_SUMMARIES
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                at: visibleRows.at(-1)!.cursorAt,
                id: visibleRows.at(-1)!.sessionId,
              }),
            ).toString("base64url"),
          }
        : {}),
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
        sql<SessionState>`case when session_row.session_kind='subagent' then
          case (select e.state from subagent_executions e where e.tenant_id=session_row.tenant_id and e.child_session_id=session_row.id)
            when 'running' then 'running' when 'completed' then 'idle' when 'cancelled' then 'idle'
            when 'failed' then 'failed' when 'unknown' then 'failed' else 'cold' end
          else session_row.state end`.as("sessionState"),
        "session_row.execution_mode as executionMode",
        "session_row.sandbox_profile_key as sandboxProfileKey",
        "session_row.working_directory as workingDirectory",
        "session_row.created_at as sessionCreatedAt",
        "session_row.updated_at as sessionUpdatedAt",
        "session_row.last_active_at as lastActiveAt",
        "session_row.conversation_parent_session_id as parentSessionId",
        "project.name as projectName",
        "session_row.conversation_fork_turn_id as forkTurnId",
        "project.created_at as projectCreatedAt",
        "workspace.deleted_at as workspaceDeletedAt",
        "workspace.seed_kind as workspaceSeedKind",
        "session_row.next_event_seq as nextEventSequence",
      ])
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.id", "=", sessionId)
      .where("session_row.pruned_at", "is", null)
      .executeTakeFirst();
    if (conversation === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }

    const lineage =
      conversation.sessionKind === "conversation"
        ? await this.#conversationLineage({
            sessionId,
            parentSessionId: conversation.parentSessionId,
            forkTurnId: conversation.forkTurnId,
          })
        : [{ sessionId, parentSessionId: null, forkTurnId: null }];
    const lineageTurnRows: ConversationHistoryRow[] = [];
    const anchor =
      beforeTurnId === undefined
        ? undefined
        : await this.#database
            .selectFrom("conversation_turns as anchor")
            .select(["anchor.session_id", "anchor.mailbox_position"])
            .where("anchor.tenant_id", "=", this.#tenantId)
            .where("anchor.turn_id", "=", beforeTurnId)
            .where("anchor.pruned_at", "is", null)
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
              .selectFrom("conversation_turns")
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
        .selectFrom("conversation_turns as run")
        .select([
          "run.session_id as originSessionId",
          "run.id as runId",
          "run.turn_id as turnId",
          "run.input_text as prompt",
          "run.operation_kind as operationKind",
          "run.stop_reason as stopReason",
          "run.input_source as promptSource",
          "run.input_uploads as uploads",
          "run.state as runState",
          sql<boolean>`(run.output_seal_id is not null and run.output_sealed_at is null)`.as(
            "waitingForSeal",
          ),
          "run.mailbox_position as mailboxPosition",
          "run.created_at as acceptedAt",
        ])
        .where("run.tenant_id", "=", this.#tenantId)
        .where("run.session_id", "=", node.sessionId)
        .where("run.pruned_at", "is", null)
        .where((eb) =>
          eb.or([eb("run.state", "!=", "queued"), eb("run.operation_kind", "=", "compact")]),
        )
        .where((eb) =>
          eb.or([
            eb("run.operation_kind", "=", "compact"),
            eb.not(eb.and([eb("run.state", "=", "cancelled"), eb("run.started_at", "is", null)])),
          ]),
        )
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
      lineageTurnRows.push(
        ...newestRows.map(({ promptSource, ...row }) => ({
          ...row,
          prompt: conversationPrompt(row.prompt, promptSource),
        })),
      );
      if (lineageTurnRows.length > MAX_CONVERSATION_TURNS) break;
    }
    const historyTruncated = lineageTurnRows.length > MAX_CONVERSATION_TURNS;
    const includedRows = lineageTurnRows.slice(0, MAX_CONVERSATION_TURNS).reverse();
    const turnIds = includedRows
      .filter((row) => row.operationKind !== "compact")
      .map((row) => row.turnId);
    const transcriptByTurnId = await readCanonicalPiTurnTranscripts(this.#database, {
      tenantId: this.#tenantId,
      turnIds,
      imageSessionId: sessionId,
    });
    const turns = includedRows.map((row) => {
      const turnState = turnStateForRun(row.runState);
      if (row.prompt === null || row.mailboxPosition === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation contains an invalid prompt turn",
        );
      }
      return {
        runId: row.runId,
        turnId: row.turnId,
        mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Conversation mailbox position"),
        prompt: row.operationKind === "compact" ? "" : row.prompt,
        ...(row.operationKind === "compact"
          ? {
              operation: {
                kind: "compact" as const,
                state: compactRunState(row.runState, row.stopReason),
                ...(row.prompt ? { instructions: row.prompt } : {}),
              },
            }
          : {}),
        ...(row.uploads.length ? { uploads: parseUserUploads(row.uploads) } : {}),
        state:
          row.waitingForSeal &&
          (turnState === "completed" || turnState === "failed" || turnState === "cancelled") &&
          transcriptByTurnId.get(row.turnId)?.terminalSequence == null
            ? ("running" as const)
            : turnState,
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
    const inheritedContext =
      conversation.sessionKind === "subagent" && beforeTurnId === undefined
        ? await this.#delegatedInheritedMessages(sessionId)
        : { inheritedMessages: [] };
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
        ...inheritedContext,
        turns,
        historyTruncated,
      },
    };
  }

  async #delegatedInheritedMessages(sessionId: string): Promise<InheritedContextPreview> {
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
        "child.pi_conversation_id as conversationId",
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
    if (execution.contextMode !== "branch" || execution.contextBaseEntryId === null)
      return { inheritedMessages: [] };
    const conversationId =
      execution.conversationId ??
      (
        await sql<{ conversation_id: string }>`select fields->>'conversation' as conversation_id
      from pi_durable_records where tenant_id=${this.#tenantId}::uuid and session_id=${execution.piSessionId}
        and kind='entry' and id=${Number(execution.contextBaseEntryId)}`.execute(this.#database)
      ).rows[0]?.conversation_id;
    if (conversationId === undefined) return { inheritedMessages: [] };
    const rows = await readDurableEntries(this.#database, {
      tenantId: this.#tenantId,
      sessionId: execution.piSessionId,
      conversationId: Number(conversationId),
      through: Number(execution.contextBaseEntryId),
      activeOnly: true,
      limit: MAX_INHERITED_CONTEXT_ENTRIES + 1,
    });
    return inheritedContextPreview(rows);
  }

  async #conversationLineage(first: ConversationLineageNode): Promise<ConversationLineageNode[]> {
    const lineage: ConversationLineageNode[] = [first];
    const seen = new Set<string>([first.sessionId]);
    let cursor: string | null = first.parentSessionId;
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
        .where("pruned_at", "is", null)
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
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom("environment_validations as validation")
            .select(["validation.report", "validation.validated_at"])
            .where("validation.tenant_id", "=", this.#tenantId)
            .where("validation.project_id", "=", projectId)
            .whereRef("validation.environment_version_id", "=", "environment.id")
            .where("validation.status", "=", "validated")
            .orderBy("validation.validated_at", "desc")
            .limit(1),
        ).as("validation"),
      )
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
    const validation = row.validation;
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
