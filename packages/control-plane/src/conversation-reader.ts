import { historyHeaders, type HistoryTurnRow } from "@pi-cloud/runtime-core/frozen-history";
import { parseScheduledOrigin } from "@pi-cloud/protocol";
import {
  readCanonicalHistoryWindow,
  type HistoryTurnSource,
} from "@pi-cloud/runtime-core/canonical-history-window";
import {
  decodeHistoryPosition,
  encodeHistoryPosition,
  type HistoryPosition,
} from "@pi-cloud/runtime-core/history-position";
import type { ConversationHistoryQuery } from "@pi-cloud/protocol";
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
import { conversationPrompt } from "@pi-cloud/runtime-core/canonical-pi-conversation";
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
type ConversationHistoryRow = {
  piSessionId: string;
  coverage: string;
  through?: { sequence: number; ordinal: number };
  operationKind: "chat" | "compact";
  frozen: boolean;
  stopReason: string | null;
  originSessionId: string;
  runId: string;
  turnId: string;
  prompt: string | null;
  scheduledOrigin?: unknown;
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
    query: ConversationHistoryQuery = {},
  ): Promise<ConversationDetailResource> {
    return (await this.getConversationView(sessionId, query)).conversation;
  }

  async getConversationView(
    sessionId: string,
    query: ConversationHistoryQuery = {},
    filters: { completedOnly?: boolean; stopAtTurnId?: string } = {},
  ): Promise<{
    conversation: ConversationDetailResource;
    canonicalThroughSequence: number;
  }> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((transaction) => {
        const reader = new ConversationReader(transaction, this.#tenantId);
        return reader.#readConversation(sessionId, query, filters);
      });
  }

  async *completedHistoryPages(sessionId: string): AsyncGenerator<ConversationDetailResource> {
    const latest = (await this.getConversationView(sessionId, {}, { completedOnly: true }))
      .conversation;
    const last = latest.turns.at(-1)?.turnId;
    if (!last) {
      yield latest;
      return;
    }
    let query: ConversationHistoryQuery = { direction: "after" },
      previous: string | null = null;
    for (;;) {
      const page = (
        await this.getConversationView(sessionId, query, {
          completedOnly: true,
          stopAtTurnId: last,
        })
      ).conversation;
      yield page;
      if (!page.history.hasAfter) return;
      const after = page.history.after;
      if (!after || after === previous) throw new Error("History export did not advance");
      previous = after;
      query = { after };
    }
  }

  async #readConversation(
    sessionId: string,
    query: ConversationHistoryQuery = {},
    filters: { completedOnly?: boolean; stopAtTurnId?: string } = {},
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
        "session_row.conversation_fork_entry_id as forkEntryId",
        "project.created_at as projectCreatedAt",
        "workspace.deleted_at as workspaceDeletedAt",
        "workspace.seed_kind as workspaceSeedKind",
        "session_row.next_event_seq as nextEventSequence",
        "session_row.pi_session_id as piSessionId",
      ])
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.id", "=", sessionId)
      .where("session_row.pruned_at", "is", null)
      .executeTakeFirst();
    if (conversation === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }

    const owner = { tenantId: this.#tenantId, sessionId };
    const findTurn = async (id: string) =>
      (
        await sql<HistoryTurnRow>`select * from pi_history_turns
      where tenant_id=${owner.tenantId}::uuid and session_id=${sessionId}::uuid and turn_id=${id}::uuid`.execute(
          this.#database,
        )
      ).rows[0];
    const cutoff = filters.stopAtTurnId ? await findTurn(filters.stopAtTurnId) : undefined;
    if (filters.stopAtTurnId && !cutoff)
      throw new ControlPlaneStoreError("not_found", "Export boundary is no longer available");
    let position: HistoryPosition | undefined;
    try {
      const cursor = query.before ?? query.after ?? query.at;
      if (cursor) position = decodeHistoryPosition(cursor, sessionId);
    } catch {
      throw new ControlPlaneStoreError("invalid_request", "Invalid conversation history cursor");
    }
    if (position?.storageId && position.storageId !== conversation.piSessionId)
      throw new ControlPlaneStoreError(
        "not_found",
        "History storage changed; refresh the history window",
      );
    let direction: "before" | "after" = query.direction ?? (query.after ? "after" : "before");
    const inclusive = Boolean(query.at || query.turnId) && query.direction === undefined;
    const anchorTurn = position?.turnId ?? query.turnId;
    const anchor = anchorTurn ? await findTurn(anchorTurn) : undefined;
    if (
      anchorTurn &&
      (!anchor || (position && position.originSessionId !== anchor.origin_session_id))
    )
      throw new ControlPlaneStoreError("not_found", "History anchor is not in this conversation");
    if (query.turnId && anchor) {
      position = {
        version: 2,
        sessionId,
        storageId: conversation.piSessionId,
        originSessionId: anchor.origin_session_id,
        turnId: query.turnId,
        sequence: 0,
        ordinal: 0,
      };
      if (query.entryId || query.toolCallId) {
        const lookup = query.entryId ?? query.toolCallId!.split(":")[1]!;
        const kind = query.toolCallId?.startsWith("task:") ? "task" : "entry";
        let record: { seq: string; ordinal: number } | undefined;
        if (anchor.frozen) {
          record = (
            await sql<{
              seq: string;
              ordinal: number;
            }>`select seq::text,ordinal from pi_history_snapshots
            where tenant_id=${this.#tenantId}::uuid and session_id=${sessionId}::uuid and turn_id=${query.turnId}::uuid and kind='record'
              and ${kind === "entry" ? sql`entry_id=${lookup}::bigint` : sql`(fields->>'task'=${lookup} or (entry_id is null and record_id=${lookup}::bigint))`}
            order by seq desc,ordinal desc limit 1`.execute(this.#database)
          ).rows[0];
        } else {
          const original = (
            await sql<{
              seq: string;
              ordinal: number;
              fields: Record<string, string>;
            }>`select seq::text,ordinal,fields from pi_durable_records
            where tenant_id=${this.#tenantId}::uuid and session_id=${anchor.pi_session_id} and id=${lookup}::bigint
              and fields->>'turn'=${query.turnId} and kind=${kind}`.execute(this.#database)
          ).rows[0];
          if (original && (kind === "entry" || original.fields.nativeKind === '"pi.tool"')) {
            record = original;
            if (kind === "task" && original.fields.resultEntry) {
              record = (
                await sql<{
                  seq: string;
                  ordinal: number;
                }>`select seq::text,ordinal from pi_durable_records
                where tenant_id=${this.#tenantId}::uuid and session_id=${anchor.pi_session_id} and id=${original.fields.resultEntry}::bigint
                  and kind='entry' and fields->>'task'=${lookup} and fields->>'turn'=${query.turnId}`.execute(
                  this.#database,
                )
              ).rows[0];
            }
          }
        }
        if (!record)
          throw new ControlPlaneStoreError("not_found", "History record is not in this Turn");
        position.sequence = Number(record.seq);
        position.ordinal = record.ordinal;
      } else direction = "after";
    }
    const rows = (
      await sql<HistoryTurnRow>`select * from pi_history_turns where tenant_id=${this.#tenantId}::uuid and session_id=${sessionId}::uuid
      ${filters.completedOnly ? sql`and state in ('completed','failed','cancelled','timed_out') and not waiting_for_seal` : sql``}
      ${cutoff ? sql`and mailbox_position<=${cutoff.mailbox_position}::bigint` : sql``}
      ${anchor ? sql`and mailbox_position ${sql.raw(direction === "before" ? "<=" : ">=")} ${anchor.mailbox_position}::bigint` : sql``}
      order by mailbox_position ${sql.raw(direction === "before" ? "desc" : "asc")},turn_id ${sql.raw(direction === "before" ? "desc" : "asc")}
      limit ${MAX_CONVERSATION_TURNS + 1}`.execute(this.#database)
    ).rows;
    const lineageTurnRows: ConversationHistoryRow[] = rows.map((r) => ({
      piSessionId: r.pi_session_id,
      coverage: r.output_display_seq,
      operationKind: r.operation_kind,
      stopReason: r.stop_reason,
      originSessionId: r.origin_session_id,
      runId: r.run_id,
      turnId: r.turn_id,
      prompt: null,
      uploads: [],
      runState: r.state as RunState,
      waitingForSeal: r.waiting_for_seal,
      mailboxPosition: r.mailbox_position,
      acceptedAt: r.created_at,
      frozen: r.frozen,
    }));
    const sources = lineageTurnRows.slice(0, MAX_CONVERSATION_TURNS);
    const window = await readCanonicalHistoryWindow(this.#database, {
      tenantId: this.#tenantId,
      sessionId,
      turns: sources as HistoryTurnSource[],
      direction,
      ...(position ? { position } : {}),
      inclusive,
    });
    const sourceByTurn = new Map(sources.map((r) => [r.turnId, r]));
    const headerByTurn = await historyHeaders(this.#database, this.#tenantId, sessionId, [
      ...window.headers,
    ]);
    const selectedTurns = [...new Set(window.positions.map((p) => p.turnId))];
    const turns = selectedTurns.map((id) => {
      const row = sourceByTurn.get(id)!;
      const header = headerByTurn.get(id);
      const transcript = window.transcripts.get(id);
      const prompt = header ? conversationPrompt(header.input_text, header.input_source) : "";
      if (prompt === null || row.mailboxPosition === null)
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation input metadata is invalid",
        );
      const before = !window.headers.has(id);
      const after =
        direction === "before"
          ? position?.turnId === id
          : window.lastContinues && window.positions.at(-1)?.turnId === id;
      const status = turnStateForRun(row.runState);
      const first = window.positions.find((p) => p.turnId === id)!;
      return {
        runId: row.runId,
        ...(header?.scheduled_origin
          ? { scheduledOrigin: parseScheduledOrigin(header.scheduled_origin) }
          : {}),
        turnId: id,
        mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Conversation mailbox position"),
        prompt: row.operationKind === "compact" ? "" : prompt,
        historyCursor: encodeHistoryPosition(first),
        ...(before ? { continuesBefore: true as const } : {}),
        ...(after ? { continuesAfter: true as const } : {}),
        ...(row.operationKind === "compact"
          ? {
              operation: {
                kind: "compact" as const,
                state: compactRunState(row.runState, row.stopReason),
                ...(prompt ? { instructions: prompt } : {}),
              },
            }
          : {}),
        ...(header?.input_uploads.length
          ? { uploads: parseUserUploads(header.input_uploads) }
          : {}),
        state:
          row.waitingForSeal &&
          ["completed", "failed", "cancelled"].includes(status) &&
          transcript?.terminalSequence == null
            ? ("running" as const)
            : status,
        ...(transcript ? { transcript } : {}),
        acceptedAt: isoTimestamp(row.acceptedAt),
        originSessionId: row.originSessionId,
      };
    });
    const cursor =
      query.before ??
      query.after ??
      query.at ??
      (position ? encodeHistoryPosition(position) : null);
    const more = window.more || lineageTurnRows.length > MAX_CONVERSATION_TURNS;
    const history = {
      before: window.positions[0] ? encodeHistoryPosition(window.positions[0]) : cursor,
      after: window.positions.at(-1) ? encodeHistoryPosition(window.positions.at(-1)!) : cursor,
      hasBefore: direction === "before" ? more : Boolean(position),
      hasAfter: direction === "after" ? more : Boolean(position),
    };
    const canonicalThroughSequence = Math.max(
      nonNegativeSafeInteger(conversation.nextEventSequence, "Conversation next event sequence") -
        1,
      ...sources.filter((r) => r.originSessionId === sessionId).map((r) => Number(r.coverage)),
    );
    const environment = await this.#loadActiveProjectEnvironment(conversation.projectId);
    const inheritedContext =
      conversation.sessionKind === "subagent" && position === undefined
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
        history,
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
