import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import {
  readDurableEntries,
  iterateDurableHistoryPrefix,
  forkIdleConversation,
  copyDurableHistory,
  type StoredHistoryEntry,
} from "@pi-cloud/pi-session-postgres/durable";
import type {
  ConversationForkResource,
  ConversationPruneResource,
  ConversationTreeBranchResource,
  ConversationTreeEntryResource,
  ConversationTreeResource,
  ConversationTreeView,
  CreateConversationForkRequest,
  CreateConversationPruneRequest,
  DelegatedSessionSummaryResource,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import {
  loadDelegatedSessionSummaries,
  loadDelegatedSessionTreeSummaries,
} from "./delegated-session-projection.ts";

const MAX_TREE_BRANCHES = 100;
const MAX_TREE_ENTRIES = 10_000;
const MAX_TREE_DELEGATIONS = 500;

type SessionRow = {
  id: string;
  title: string;
  parentSessionId: string | null;
  forkTurnId: string | null;
  forkEntryId: string | null;
};

type PiEntryRow = {
  id: string;
  turnId: string | null;
  seq: string;
  parentId: string | null;
  type: string;
  native: StoredHistoryEntry;
  timestampMs: string;
  payload: Record<string, unknown>;
};

type CompletedTurnRow = {
  sessionId: string;
  turnId: string;
  mailboxPosition: string;
};

type PiSessionBinding = {
  productSessionId: string;
  piSessionId: string;
  piConversationId: string | null;
  contextBaseEntryId: string | null;
  forkEntryId: string | null;
};

type MappedEntry = ConversationTreeEntryResource & { readonly index: number };

function safeInteger(value: string | number, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneStoreError("control_plane_misconfigured", `${description} is invalid`);
  }
  return parsed;
}

function messageFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const message = Array.isArray(payload.model)
    ? payload.model.find(
        (item: { role?: string }) => item.role === "user" || item.role === "assistant",
      )
    : undefined;
  return typeof message === "object" && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : null;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function isFinalAssistant(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || typeof message.stopReason !== "string") return false;
  return !["toolUse", "error", "aborted", "pending", "deferred"].includes(message.stopReason);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isoFromMilliseconds(value: string): string {
  const date = new Date(safeInteger(value, "Pi entry timestamp"));
  if (Number.isNaN(date.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Pi entry timestamp is invalid",
    );
  }
  return date.toISOString();
}

function activeBranch(rows: readonly PiEntryRow[], leafId: string | null): PiEntryRow[] {
  if (leafId === null) return [];
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const reversed: PiEntryRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null) {
    if (seen.has(cursor)) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Pi Session tree contains a cycle",
      );
    }
    seen.add(cursor);
    const row = byId.get(cursor);
    if (row === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Pi Session tree has a missing parent",
      );
    }
    reversed.push(row);
    cursor = row.parentId;
  }
  return reversed.reverse();
}

function ownBranch(branch: readonly PiEntryRow[], forkEntryId: string | null): PiEntryRow[] {
  if (forkEntryId === null) return [...branch];
  const anchor = branch.findIndex((entry) => entry.id === forkEntryId);
  if (anchor < 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Fork anchor is missing from the child Pi Session",
    );
  }
  return branch.slice(anchor + 1);
}

function mappedConversationEntries(
  branch: readonly PiEntryRow[],
  turns: readonly CompletedTurnRow[],
): MappedEntry[] {
  const completed = new Set(turns.map((turn) => turn.turnId));
  const users = new Map<string, MappedEntry>();
  const finals = new Map<string, MappedEntry>();
  for (const [index, entry] of branch.entries()) {
    if (entry.turnId === null || !completed.has(entry.turnId)) continue;
    const message = messageFromPayload(entry.payload);
    if (message === null) continue;
    const finalAssistant = isFinalAssistant(message);
    if (message.role !== "user" && !finalAssistant) continue;
    const mapped: MappedEntry = {
      entryId: entry.id,
      parentEntryId: entry.parentId,
      turnId: entry.turnId,
      role: finalAssistant ? "assistant" : "user",
      text: messageText(message),
      finalAssistant,
      createdAt: isoFromMilliseconds(entry.timestampMs),
      index,
    };
    if (finalAssistant) finals.set(entry.turnId, mapped);
    else if (!users.has(entry.turnId)) users.set(entry.turnId, mapped);
  }
  const result: MappedEntry[] = [];
  for (const final of [...finals.values()].sort((a, b) => a.index - b.index)) {
    const user = users.get(final.turnId);
    if (user !== undefined) result.push(user);
    result.push(final);
  }
  return result;
}

async function sessionEntries(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  bindings: readonly PiSessionBinding[],
  includeInherited?: string,
): Promise<Map<string, PiEntryRow[]>> {
  const result = new Map<string, PiEntryRow[]>();
  for (const binding of bindings) {
    if (binding.piConversationId === null) {
      result.set(binding.productSessionId, []);
      continue;
    }
    const entries = (
      await readDurableEntries(database, {
        tenantId,
        sessionId: binding.piSessionId,
        conversationId: Number(binding.piConversationId),
        navigationOnly: true,
        ...(binding.productSessionId === includeInherited
          ? {}
          : {
              from: Math.max(
                Number(binding.contextBaseEntryId ?? 0),
                Number(binding.forkEntryId ?? 0),
              ),
            }),
        includeEntryIds: [binding.contextBaseEntryId, binding.forkEntryId]
          .filter((value): value is string => value !== null)
          .map(Number),
        limit: MAX_TREE_ENTRIES + 1,
      })
    ).reverse();
    if (entries.length > MAX_TREE_ENTRIES)
      throw new ControlPlaneStoreError("invalid_request", "Conversation tree is too large");
    result.set(
      binding.productSessionId,
      entries.map((row, index) => ({
        id: String(row.entry.id),
        turnId: row.turnId,
        seq: String(row.seq),
        parentId: index ? String(entries[index - 1]!.entry.id) : null,
        type: row.entry.kind,
        timestampMs: String(Date.parse(row.createdAt)),
        payload: row.entry as unknown as Record<string, unknown>,
        native: row,
      })),
    );
  }
  return result;
}

async function sessionBindings(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<PiSessionBinding[]> {
  if (sessionIds.length === 0) return [];
  return database
    .selectFrom("sessions as session")
    .leftJoin("subagent_executions as execution", (join) =>
      join
        .onRef("execution.tenant_id", "=", "session.tenant_id")
        .onRef("execution.child_session_id", "=", "session.id"),
    )
    .select([
      "session.id as productSessionId",
      "session.pi_session_id as piSessionId",
      "session.pi_conversation_id as piConversationId",
      "session.conversation_fork_entry_id as forkEntryId",
      "execution.pi_context_base_entry_id as contextBaseEntryId",
    ])
    .where("session.tenant_id", "=", tenantId)
    .where("session.id", "in", sessionIds)
    .execute();
}

async function completedTurns(
  database: Kysely<Database> | Transaction<Database>,
  tenantId: string,
  sessionIds: readonly string[],
): Promise<Map<string, CompletedTurnRow[]>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await database
    .selectFrom("conversation_turns as run")
    .select([
      "run.session_id as sessionId",
      "run.turn_id as turnId",
      "run.mailbox_position as mailboxPosition",
    ])
    .where("run.tenant_id", "=", tenantId)
    .where("run.session_id", "in", sessionIds)
    .where("run.pruned_at", "is", null)
    .where("run.state", "=", "completed")
    .orderBy("run.session_id")
    .orderBy("run.mailbox_position")
    .execute();
  const grouped = new Map<string, CompletedTurnRow[]>();
  for (const row of rows) {
    if (row.mailboxPosition === null) continue;
    const turns = grouped.get(row.sessionId) ?? [];
    turns.push({
      sessionId: row.sessionId,
      turnId: row.turnId,
      mailboxPosition: row.mailboxPosition,
    });
    grouped.set(row.sessionId, turns);
  }
  return grouped;
}

function conversationLeaves(
  entries: ReadonlyMap<string, readonly PiEntryRow[]>,
): Map<string, string | null> {
  return new Map([...entries].map(([id, rows]) => [id, rows.at(-1)?.id ?? null]));
}

export class ConversationTreeService {
  readonly #database: Kysely<Database>;
  readonly #idGenerator: () => string;

  constructor(options: { database: Kysely<Database>; idGenerator?: () => string }) {
    this.#database = options.database;
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async tree(
    tenantId: string,
    currentSessionId: string,
    view: ConversationTreeView,
  ): Promise<ConversationTreeResource> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((database) => this.#readTree(database, tenantId, currentSessionId, view));
  }

  async #readTree(
    database: Transaction<Database>,
    tenantId: string,
    currentSessionId: string,
    view: ConversationTreeView,
  ): Promise<ConversationTreeResource> {
    const selected = await database
      .selectFrom("sessions")
      .select(["id", "session_kind as sessionKind"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", currentSessionId)
      .where("pruned_at", "is", null)
      .executeTakeFirst();
    if (selected === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }
    const selectedExecution =
      selected.sessionKind === "subagent"
        ? await database
            .selectFrom("subagent_executions")
            .select([
              "id as executionId",
              "parent_session_id as parentSessionId",
              "root_session_id as rootSessionId",
              "parent_execution_id as parentExecutionId",
              "depth",
              "created_at as createdAt",
              "context_mode as contextMode",
            ])
            .where("tenant_id", "=", tenantId)
            .where("child_session_id", "=", selected.id)
            .executeTakeFirst()
        : undefined;
    const humanSessionId =
      selected.sessionKind === "conversation" ? selected.id : selectedExecution?.rootSessionId;
    if (humanSessionId === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Delegated Session has no parent execution",
      );
    }
    const lineage = await this.#lineage(database, tenantId, humanSessionId);
    const humanRootSessionId = lineage[0]!.id;
    const humanSessions =
      view === "focus" ? lineage : await this.#family(database, tenantId, humanRootSessionId);
    const delegated = await this.#delegatedFamily(
      database,
      tenantId,
      view === "full"
        ? humanSessions.map((session) => session.id)
        : selected.sessionKind === "subagent"
          ? [selected.id]
          : [],
    );
    const delegatedBySession = new Map(
      delegated.map((summary) => [summary.sessionId, summary] as const),
    );
    const selectedDelegated =
      selected.sessionKind === "subagent"
        ? (delegatedBySession.get(selected.id) ??
          (await this.#delegatedSummary(database, tenantId, selected.id)))
        : undefined;
    const selectedDelegatedAncestorSessionIds =
      selectedExecution === undefined
        ? []
        : await this.#delegatedAncestorSessionIds(
            database,
            tenantId,
            selectedExecution.executionId,
          );
    const sessionIds = [
      ...humanSessions.map((session) => session.id),
      ...delegated.map((summary) => summary.sessionId),
      ...selectedDelegatedAncestorSessionIds,
      ...(selectedDelegated === undefined ? [] : [selectedDelegated.sessionId]),
    ];
    const uniqueSessionIds = [...new Set(sessionIds)];
    const bindings = await sessionBindings(database, tenantId, uniqueSessionIds);
    const bindingBySession = new Map(
      bindings.map((binding) => [binding.productSessionId, binding] as const),
    );
    const [entriesBySession, turnsBySession] = await Promise.all([
      sessionEntries(
        database,
        tenantId,
        bindings,
        view === "focus" ? selectedDelegated?.sessionId : undefined,
      ),
      completedTurns(database, tenantId, uniqueSessionIds),
    ]);
    const leaves = conversationLeaves(entriesBySession);
    let entryCount = 0;
    const humanBranches: ConversationTreeBranchResource[] = humanSessions.map((session, index) => {
      const allEntries = entriesBySession.get(session.id) ?? [];
      const branch = ownBranch(
        activeBranch(allEntries, leaves.get(session.id) ?? null),
        session.forkEntryId,
      );
      let mapped = mappedConversationEntries(branch, turnsBySession.get(session.id) ?? []);
      if (view === "focus") {
        const child = humanSessions[index + 1];
        if (child?.parentSessionId === session.id && child.forkEntryId !== null) {
          const boundary = mapped.findIndex((entry) => entry.entryId === child.forkEntryId);
          if (boundary < 0) {
            throw new ControlPlaneStoreError(
              "control_plane_misconfigured",
              "Focused fork anchor is missing from its parent branch",
            );
          }
          mapped = mapped.slice(0, boundary + 1);
        }
      }
      entryCount += mapped.length;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw new ControlPlaneStoreError("invalid_request", "Conversation tree is too large");
      }
      return {
        kind: "conversation",
        sessionId: session.id,
        title: session.title,
        parentSessionId: session.parentSessionId,
        forkedFromTurnId: session.forkTurnId,
        forkedFromEntryId: session.forkEntryId,
        current: session.id === currentSessionId,
        entries: mapped.map(({ index: _index, ...entry }) => entry),
      };
    });
    const humanBranchBySession = new Map(
      humanBranches.map((branch) => [branch.sessionId, branch] as const),
    );

    const delegatedBranches: ConversationTreeBranchResource[] = [];
    for (const summary of delegated) {
      const binding = bindingBySession.get(summary.sessionId);
      if (binding === undefined) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Delegated Session has no Pi lane binding",
        );
      }
      const ownEntries = ownBranch(
        activeBranch(
          entriesBySession.get(summary.sessionId) ?? [],
          leaves.get(summary.sessionId) ?? null,
        ),
        binding.contextBaseEntryId,
      );
      const mapped = mappedConversationEntries(
        ownEntries,
        turnsBySession.get(summary.sessionId) ?? [],
      );
      entryCount += mapped.length;
      if (entryCount > MAX_TREE_ENTRIES) {
        throw new ControlPlaneStoreError("invalid_request", "Conversation tree is too large");
      }
      const parentBranch =
        humanBranchBySession.get(summary.parentSessionId) ??
        delegatedBranches.find((branch) => branch.sessionId === summary.parentSessionId);
      const anchor = parentBranch?.entries
        .filter((entry) => entry.turnId === summary.parentTurnId)
        .at(-1);
      delegatedBranches.push({
        kind: "subagent",
        sessionId: summary.sessionId,
        title: summary.title,
        parentSessionId: summary.parentSessionId,
        forkedFromTurnId: summary.parentTurnId,
        forkedFromEntryId: anchor?.entryId ?? null,
        current: summary.sessionId === currentSessionId,
        contextMode: summary.contextMode,
        sandboxMode: summary.sandboxMode,
        delegatedState: summary.state,
        entries: mapped.map(({ index: _index, ...entry }) => entry),
      });
    }

    if (view === "focus" && selectedDelegated !== undefined) {
      const active = activeBranch(
        entriesBySession.get(selectedDelegated.sessionId) ?? [],
        leaves.get(selectedDelegated.sessionId) ?? null,
      );
      const binding = bindingBySession.get(selectedDelegated.sessionId);
      if (binding === undefined) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Delegated Session has no Pi lane binding",
        );
      }
      const contextBaseIndex =
        binding.contextBaseEntryId === null
          ? -1
          : active.findIndex((entry) => entry.id === binding.contextBaseEntryId);
      if (binding.contextBaseEntryId !== null && contextBaseIndex < 0) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Delegated Session context boundary is missing from its Pi lane",
        );
      }
      const inheritedBranch = active.slice(0, contextBaseIndex + 1);
      const inheritedTurns = [
        ...lineage.map((session) => session.id),
        ...selectedDelegatedAncestorSessionIds.filter(
          (sessionId) => sessionId !== selectedDelegated.sessionId,
        ),
      ]
        .flatMap((sessionId) => turnsBySession.get(sessionId) ?? [])
        .filter((turn) => turn.turnId !== selectedDelegated.parentTurnId);
      const inherited = mappedConversationEntries(inheritedBranch, inheritedTurns);
      const pendingParentUser = inheritedBranch.find((entry) => {
        if (entry.turnId !== selectedDelegated.parentTurnId || entry.type !== "message")
          return false;
        return messageFromPayload(entry.payload)?.role === "user";
      });
      if (pendingParentUser !== undefined) {
        inherited.push({
          entryId: pendingParentUser.id,
          parentEntryId: pendingParentUser.parentId,
          turnId: selectedDelegated.parentTurnId,
          role: "user",
          text: messageText(messageFromPayload(pendingParentUser.payload)!),
          finalAssistant: false,
          createdAt: isoFromMilliseconds(pendingParentUser.timestampMs),
          index: active.indexOf(pendingParentUser),
        });
      }
      const own = mappedConversationEntries(
        active.slice(contextBaseIndex + 1),
        turnsBySession.get(selectedDelegated.sessionId) ?? [],
      );
      const mapped = [...inherited, ...own];
      if (mapped.length > MAX_TREE_ENTRIES) {
        throw new ControlPlaneStoreError("invalid_request", "Conversation tree is too large");
      }
      const focusedRoot: ConversationTreeBranchResource = {
        kind: "subagent",
        sessionId: selectedDelegated.sessionId,
        title: selectedDelegated.title,
        parentSessionId: null,
        forkedFromTurnId: null,
        forkedFromEntryId: null,
        current: true,
        contextMode: selectedDelegated.contextMode,
        sandboxMode: selectedDelegated.sandboxMode,
        delegatedState: selectedDelegated.state,
        entries: mapped.map(({ index: _index, ...entry }) => entry),
      };
      const focusedDescendants = delegatedBranches.map((branch) => {
        if (branch.parentSessionId !== selectedDelegated.sessionId) return branch;
        const anchor = focusedRoot.entries
          .filter((entry) => entry.turnId === branch.forkedFromTurnId)
          .at(-1);
        return { ...branch, forkedFromEntryId: anchor?.entryId ?? null };
      });
      return {
        rootSessionId: selectedDelegated.sessionId,
        currentSessionId,
        view,
        branches: [focusedRoot, ...focusedDescendants],
        delegatedSessions: [selectedDelegated, ...delegated],
      };
    }

    const branches = [...humanBranches, ...(view === "full" ? delegatedBranches : [])];
    if (branches.length > MAX_TREE_BRANCHES) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Conversation tree has too many branches",
      );
    }
    return {
      rootSessionId: humanRootSessionId,
      currentSessionId,
      view,
      branches,
      delegatedSessions: delegated,
    };
  }

  async #delegatedSummary(
    database: Transaction<Database>,
    tenantId: string,
    childSessionId: string,
  ): Promise<DelegatedSessionSummaryResource> {
    const execution = await database
      .selectFrom("subagent_executions")
      .select("parent_session_id as parentSessionId")
      .where("tenant_id", "=", tenantId)
      .where("child_session_id", "=", childSessionId)
      .executeTakeFirst();
    if (execution === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Delegated Session has no parent execution",
      );
    }
    const loaded = await loadDelegatedSessionSummaries(database, {
      tenantId,
      parentSessionIds: [execution.parentSessionId],
      maximum: MAX_TREE_DELEGATIONS,
    });
    const summary = loaded.items.find((item) => item.sessionId === childSessionId);
    if (summary === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Delegated Session projection is missing",
      );
    }
    return summary;
  }

  async #delegatedFamily(
    database: Transaction<Database>,
    tenantId: string,
    initialParentSessionIds: readonly string[],
  ): Promise<DelegatedSessionSummaryResource[]> {
    const loaded = await loadDelegatedSessionTreeSummaries(database, {
      tenantId,
      rootParentSessionIds: initialParentSessionIds,
      maximum: MAX_TREE_DELEGATIONS,
    });
    if (loaded.truncated) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Conversation tree has too many delegates",
      );
    }
    return loaded.items;
  }

  async #delegatedAncestorSessionIds(
    database: Transaction<Database>,
    tenantId: string,
    executionId: string,
  ): Promise<string[]> {
    const ancestors = await sql<{ sessionId: string; depth: number }>`
      with recursive execution_ancestors as (
        select id, parent_execution_id, child_session_id, depth
          from subagent_executions
         where tenant_id = ${tenantId}::uuid
           and id = ${executionId}::uuid
        union all
        select parent.id, parent.parent_execution_id, parent.child_session_id, parent.depth
          from subagent_executions parent
          join execution_ancestors child on child.parent_execution_id = parent.id
         where parent.tenant_id = ${tenantId}::uuid
      )
      select child_session_id as "sessionId", depth
        from execution_ancestors
       order by depth asc
    `.execute(database);
    return ancestors.rows.map((row) => row.sessionId);
  }

  async prune(
    tenantId: string,
    sessionId: string,
    idempotencyKey: string,
    request: CreateConversationPruneRequest,
  ): Promise<ConversationPruneResource> {
    const requestSha256 = sha256(request);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await transaction
          .selectFrom("conversation_prune_operations")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          if (replay.request_sha256 !== requestSha256) {
            throw new ControlPlaneStoreError(
              "idempotency_conflict",
              "Idempotency key was already used for a different conversation prune",
            );
          }
          return {
            sessionId,
            anchorTurnId: replay.anchor_turn_id,
            anchorEntryId: replay.anchor_entry_id,
            prunedTurnCount: replay.pruned_turn_count,
            prunedSessionCount: replay.pruned_session_count,
            replayed: true,
            createdAt: new Date(replay.created_at).toISOString(),
          };
        }

        const session = await transaction
          .selectFrom("sessions")
          .select([
            "id",
            "state",
            "session_kind as sessionKind",
            "conversation_fork_entry_id as forkEntryId",
            "pruned_at as prunedAt",
          ])
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .forUpdate()
          .executeTakeFirst();
        if (
          session === undefined ||
          session.prunedAt !== null ||
          session.sessionKind !== "conversation"
        ) {
          throw new ControlPlaneStoreError("not_found", "Conversation was not found");
        }
        if (!(session.state === "cold" || session.state === "idle" || session.state === "failed")) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before deleting later messages",
          );
        }
        const unsettled = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("pruned_at", "is", null)
          .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
          .limit(1)
          .executeTakeFirst();
        const pendingSeal = await transaction
          .selectFrom("runs as run")
          .select("run.id")
          .where("run.session_id", "=", sessionId)
          .where("run.output_seal_id", "is not", null)
          .where("run.output_sealed_at", "is", null)
          .limit(1)
          .executeTakeFirst();
        if (pendingSeal)
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for conversation output to settle before deleting later messages",
          );
        if (unsettled !== undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before deleting later messages",
          );
        }

        const bindings = await sessionBindings(transaction, tenantId, [sessionId]);
        const [entriesBySession, turnsBySession] = await Promise.all([
          sessionEntries(transaction, tenantId, bindings),
          completedTurns(transaction, tenantId, [sessionId]),
        ]);
        const leaves = conversationLeaves(entriesBySession);
        const branch = ownBranch(
          activeBranch(entriesBySession.get(sessionId) ?? [], leaves.get(sessionId) ?? null),
          session.forkEntryId,
        );
        const target = mappedConversationEntries(branch, turnsBySession.get(sessionId) ?? []).find(
          (entry) =>
            entry.finalAssistant &&
            entry.turnId === request.turnId &&
            entry.entryId === request.entryId,
        );
        if (target === undefined) {
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Conversation prune target is not an owned completed final response",
          );
        }
        const anchorRun = await transaction
          .selectFrom("runs")
          .select("mailbox_position as mailboxPosition")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("turn_id", "=", request.turnId)
          .executeTakeFirstOrThrow();

        const prunedTurns = await transaction
          .selectFrom("runs as run")
          .select("run.turn_id as id")
          .where("run.tenant_id", "=", tenantId)
          .where("run.session_id", "=", sessionId)
          .where("run.mailbox_position", ">", anchorRun.mailboxPosition)
          .where("run.pruned_at", "is", null)
          .execute();
        const prunedTurnIds = prunedTurns.map((turn) => turn.id);

        const descendantResult = await sql<{ id: string }>`
          with recursive descendants as (
            select child.id
              from sessions child
              join runs anchor
                on anchor.tenant_id = child.tenant_id
               and anchor.session_id = child.conversation_parent_session_id
               and anchor.turn_id = child.conversation_fork_turn_id
             where child.tenant_id = ${tenantId}::uuid
               and child.conversation_parent_session_id = ${sessionId}::uuid
               and child.session_kind = 'conversation'
               and child.pruned_at is null
               and anchor.mailbox_position >= ${anchorRun.mailboxPosition}::bigint
            union
            select child.id
              from sessions child
              join descendants parent on child.conversation_parent_session_id = parent.id
             where child.tenant_id = ${tenantId}::uuid
               and child.session_kind = 'conversation'
               and child.pruned_at is null
          )
          select id from descendants
        `.execute(transaction);
        const descendantIds = descendantResult.rows.map((row) => row.id);
        if (descendantIds.length > 0) {
          const activeDescendant = await transaction
            .selectFrom("sessions")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("id", "in", descendantIds)
            .where("state", "not in", ["cold", "idle", "failed"])
            .limit(1)
            .executeTakeFirst();
          const unsettledDescendant = await transaction
            .selectFrom("runs")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("session_id", "in", descendantIds)
            .where("pruned_at", "is", null)
            .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
            .limit(1)
            .executeTakeFirst();
          if (activeDescendant !== undefined || unsettledDescendant !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "A descendant conversation is still running",
            );
          }
        }

        const affectedSubagentConditions = [
          ...(descendantIds.length === 0
            ? []
            : [
                sql`execution.parent_session_id in (${sql.join(
                  descendantIds.map((id) => sql`${id}::uuid`),
                )})`,
              ]),
          ...(prunedTurnIds.length === 0
            ? []
            : [
                sql`execution.parent_turn_id in (${sql.join(
                  prunedTurnIds.map((id) => sql`${id}::uuid`),
                )})`,
              ]),
        ];
        const subagentRows =
          affectedSubagentConditions.length === 0
            ? []
            : (
                await sql<{ sessionId: string; executionState: string }>`
                  with recursive affected_executions as (
                    select execution.id, execution.child_session_id, execution.state
                      from subagent_executions execution
                     where execution.tenant_id = ${tenantId}::uuid
                       and (${sql.join(affectedSubagentConditions, sql` or `)})
                    union
                    select child.id, child.child_session_id, child.state
                      from subagent_executions child
                      join affected_executions parent on child.parent_execution_id = parent.id
                     where child.tenant_id = ${tenantId}::uuid
                  )
                  select child_session_id as "sessionId", state as "executionState"
                    from affected_executions
                `.execute(transaction)
              ).rows;
        if (
          subagentRows.some(
            (row) => row.executionState === "preparing" || row.executionState === "running",
          )
        ) {
          throw new ControlPlaneStoreError("conflict", "Delegated work is still active");
        }
        const subagentSessionIds = [...new Set(subagentRows.map((row) => row.sessionId))];
        const sessionsToPrune = [...new Set([...descendantIds, ...subagentSessionIds])];
        const now = new Date();
        if (prunedTurnIds.length > 0) {
          await transaction
            .updateTable("runs")
            .set({ pruned_at: now })
            .where("tenant_id", "=", tenantId)
            .where("turn_id", "in", prunedTurnIds)
            .execute();
        }
        if (sessionsToPrune.length > 0) {
          await transaction
            .updateTable("sessions")
            .set({
              pruned_at: now,
              updated_at: now,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
            })
            .where("tenant_id", "=", tenantId)
            .where("id", "in", sessionsToPrune)
            .where("pruned_at", "is", null)
            .execute();
        }

        const binding = bindings.find((candidate) => candidate.productSessionId === sessionId);
        if (!binding?.piConversationId)
          throw new ControlPlaneStoreError("conflict", "Conversation has no native branch");
        const conversationId = await forkIdleConversation(
          transaction,
          { tenantId, sessionId: binding.piSessionId },
          Number(binding.piConversationId),
          Number(request.entryId),
        );
        await transaction
          .updateTable("sessions")
          .set({ pi_conversation_id: String(conversationId) })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("sessions")
          .set({ state: "idle", updated_at: now, last_active_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sessionId)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("conversation_prune_operations")
          .values({
            tenant_id: tenantId,
            session_id: sessionId,
            idempotency_key: idempotencyKey,
            request_sha256: requestSha256,
            anchor_turn_id: request.turnId,
            anchor_entry_id: request.entryId,
            pruned_turn_count: prunedTurnIds.length,
            pruned_session_count: sessionsToPrune.length,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        return {
          sessionId,
          anchorTurnId: request.turnId,
          anchorEntryId: request.entryId,
          prunedTurnCount: prunedTurnIds.length,
          prunedSessionCount: sessionsToPrune.length,
          replayed: false,
          createdAt: now.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "conversation_prune_operations_pkey"
      ) {
        return this.prune(tenantId, sessionId, idempotencyKey, request);
      }
      throw error;
    }
  }

  async fork(
    tenantId: string,
    sourceSessionId: string,
    idempotencyKey: string,
    request: CreateConversationForkRequest,
  ): Promise<ConversationForkResource> {
    const requestSha256 = sha256(request);
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await transaction
          .selectFrom("conversation_fork_operations as operation")
          .innerJoin("sessions as child", (join) =>
            join
              .onRef("child.tenant_id", "=", "operation.tenant_id")
              .onRef("child.id", "=", "operation.child_session_id"),
          )
          .innerJoin("workspaces as workspace", (join) =>
            join
              .onRef("workspace.tenant_id", "=", "child.tenant_id")
              .onRef("workspace.id", "=", "child.workspace_id"),
          )
          .select([
            "operation.request_sha256 as requestSha256",
            "operation.source_turn_id as sourceTurnId",
            "operation.source_entry_id as sourceEntryId",
            "child.id",
            "child.title",
            "workspace.deleted_at as workspaceDeletedAt",
            "child.project_id as projectId",
            "child.workspace_id as workspaceId",
            "child.execution_mode as executionMode",
            "child.sandbox_profile_key as sandboxProfileKey",
            "child.working_directory as workingDirectory",
            "child.desired_model_profile_id as modelProfileId",
            "child.created_at as createdAt",
          ])
          .where("operation.tenant_id", "=", tenantId)
          .where("operation.source_session_id", "=", sourceSessionId)
          .where("operation.idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          if (replay.requestSha256 !== requestSha256) {
            throw new ControlPlaneStoreError(
              "idempotency_conflict",
              "Idempotency key was already used for a different fork",
            );
          }
          return {
            session: {
              sessionId: replay.id,
              title: replay.title,
              projectId: replay.projectId,
              workspaceId: replay.workspaceId,
              workspaceState: replay.workspaceDeletedAt === null ? "attached" : "missing",
              state: "cold",
              executionMode: replay.executionMode,
              sandboxProfileKey: replay.sandboxProfileKey,
              workingDirectory: replay.workingDirectory,
              modelProfileId: replay.modelProfileId,
              createdAt: new Date(replay.createdAt).toISOString(),
            },
            parentSessionId: sourceSessionId,
            forkedFromTurnId: replay.sourceTurnId,
            forkedFromEntryId: replay.sourceEntryId,
            replayed: true,
          };
        }

        const source = await transaction
          .selectFrom("sessions")
          .select([
            "id",
            "title",
            "project_id",
            "workspace_id",
            "desired_model_profile_id",
            "desired_thinking_level",
            "desired_service_tier",
            "agent_revision_id",
            "created_by_user_id",
            "state",
            "execution_mode",
            "sandbox_profile_key",
            "working_directory",
            "conversation_fork_entry_id",
            "pruned_at",
          ])
          .select((eb) =>
            eb
              .selectFrom("workspaces")
              .select("deleted_at")
              .whereRef("workspaces.tenant_id", "=", "sessions.tenant_id")
              .whereRef("workspaces.id", "=", "sessions.workspace_id")
              .as("workspaceDeletedAt"),
          )
          .where("tenant_id", "=", tenantId)
          .where("id", "=", sourceSessionId)
          .forUpdate()
          .executeTakeFirst();
        if (source === undefined || source.pruned_at !== null) {
          throw new ControlPlaneStoreError("not_found", "Conversation was not found");
        }
        if (!(["cold", "idle", "failed"] as const).some((state) => state === source.state)) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before forking",
          );
        }
        const unsettled = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sourceSessionId)
          .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
          .executeTakeFirst();
        if (unsettled !== undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Wait for the current conversation run to settle before forking",
          );
        }
        const policy = await transaction
          .selectFrom("tenant_runtime_policies")
          .select("maximum_sessions")
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (policy.maximum_sessions !== null) {
          const sessionCount = await transaction
            .selectFrom("sessions")
            .select((expression) => expression.fn.countAll<string>().as("count"))
            .where("tenant_id", "=", tenantId)
            .executeTakeFirstOrThrow();
          if (safeInteger(sessionCount.count, "Tenant Session count") >= policy.maximum_sessions) {
            throw new ControlPlaneStoreError(
              "tenant_quota_exceeded",
              "Tenant session quota has been reached",
            );
          }
        }
        const bindings = await sessionBindings(transaction, tenantId, [sourceSessionId]);
        const [entriesBySession, turnsBySession] = await Promise.all([
          sessionEntries(transaction, tenantId, bindings),
          completedTurns(transaction, tenantId, [sourceSessionId]),
        ]);
        const leafId = entriesBySession.get(sourceSessionId)?.at(-1)?.id;
        if (!leafId)
          throw new ControlPlaneStoreError("conflict", "Conversation has no forkable Pi history");
        const sourceBranch = activeBranch(entriesBySession.get(sourceSessionId) ?? [], leafId);
        const sourceOwnBranch = ownBranch(sourceBranch, source.conversation_fork_entry_id);
        const mapped = mappedConversationEntries(
          sourceOwnBranch,
          turnsBySession.get(sourceSessionId) ?? [],
        );
        const target = mapped.find(
          (entry) =>
            entry.finalAssistant &&
            entry.turnId === request.turnId &&
            entry.entryId === request.entryId,
        );
        if (target === undefined) {
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Fork target is not a completed final assistant response",
          );
        }
        const targetIndex = sourceBranch.findIndex((entry) => entry.id === request.entryId);
        if (targetIndex < 0) {
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Fork entry is not on the main branch",
          );
        }
        const childSessionId = this.#idGenerator();
        const title = request.title ?? `${source.title} · 分支`;

        const child = await transaction
          .insertInto("sessions")
          .values({
            id: childSessionId,
            pi_session_id: childSessionId,
            pi_conversation_id: "1",
            title,
            tenant_id: tenantId,
            project_id: source.project_id,
            workspace_id: source.workspace_id,
            desired_model_profile_id: source.desired_model_profile_id,
            desired_thinking_level: source.desired_thinking_level,
            desired_service_tier: source.desired_service_tier,
            agent_revision_id: source.agent_revision_id,
            created_by_user_id: source.created_by_user_id,
            state: "cold",
            execution_mode: source.execution_mode,
            sandbox_profile_key: source.sandbox_profile_key,
            working_directory: source.working_directory,
            conversation_parent_session_id: sourceSessionId,
            conversation_fork_turn_id: request.turnId,
            conversation_fork_entry_id: request.entryId,
          })
          .returning(["id", "title", "created_at"])
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("pi_sessions")
          .values({
            tenant_id: tenantId,
            id: childSessionId,
          })
          .executeTakeFirstOrThrow();
        await copyDurableHistory(
          transaction,
          { tenantId, sessionId: childSessionId },
          iterateDurableHistoryPrefix(transaction, {
            tenantId,
            sessionId: bindings[0]!.piSessionId,
            conversationId: Number(bindings[0]!.piConversationId),
            through: Number(request.entryId),
          }),
          {
            tenantId,
            sessionId: bindings[0]!.piSessionId,
            conversationId: Number(bindings[0]!.piConversationId),
          },
        );
        await transaction
          .insertInto("conversation_fork_operations")
          .values({
            tenant_id: tenantId,
            source_session_id: sourceSessionId,
            idempotency_key: idempotencyKey,
            request_sha256: requestSha256,
            source_turn_id: request.turnId,
            source_entry_id: request.entryId,
            child_session_id: childSessionId,
          })
          .executeTakeFirstOrThrow();
        return {
          session: {
            sessionId: child.id,
            title: child.title,
            projectId: source.project_id,
            workspaceId: source.workspace_id,
            workspaceState: source.workspaceDeletedAt === null ? "attached" : "missing",
            state: "cold",
            executionMode: source.execution_mode,
            sandboxProfileKey: source.sandbox_profile_key,
            workingDirectory: source.working_directory,
            modelProfileId: source.desired_model_profile_id,
            createdAt: new Date(child.created_at).toISOString(),
          },
          parentSessionId: sourceSessionId,
          forkedFromTurnId: request.turnId,
          forkedFromEntryId: request.entryId,
          replayed: false,
        };
      });
    } catch (error: unknown) {
      if (error instanceof ControlPlaneStoreError) throw error;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "conversation_fork_operations_pkey"
      ) {
        return this.fork(tenantId, sourceSessionId, idempotencyKey, request);
      }
      throw error;
    }
  }

  async #lineage(
    database: Transaction<Database>,
    tenantId: string,
    sessionId: string,
  ): Promise<SessionRow[]> {
    const result: SessionRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = sessionId;
    while (cursor !== null) {
      if (seen.has(cursor) || result.length >= MAX_TREE_BRANCHES) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation lineage is invalid or too deep",
        );
      }
      seen.add(cursor);
      const row = await database
        .selectFrom("sessions")
        .select([
          "id",
          "title",
          "conversation_parent_session_id as parentSessionId",
          "conversation_fork_turn_id as forkTurnId",
          "conversation_fork_entry_id as forkEntryId",
        ])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", cursor)
        .where("session_kind", "=", "conversation")
        .where("pruned_at", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      result.push(row);
      cursor = row.parentSessionId;
    }
    return result.reverse();
  }

  async #family(
    database: Transaction<Database>,
    tenantId: string,
    rootSessionId: string,
  ): Promise<SessionRow[]> {
    const family = await sql<{
      id: string;
      title: string;
      parent_session_id: string | null;
      fork_turn_id: string | null;
      fork_entry_id: string | null;
      depth: number;
    }>`
      with recursive family as (
        select id,
               title,
               conversation_parent_session_id as parent_session_id,
               conversation_fork_turn_id as fork_turn_id,
               conversation_fork_entry_id as fork_entry_id,
               created_at,
               0 as depth
          from sessions
         where tenant_id = ${tenantId}::uuid
           and id = ${rootSessionId}::uuid
           and pruned_at is null
        union all
        select child.id,
               child.title,
               child.conversation_parent_session_id,
               child.conversation_fork_turn_id,
               child.conversation_fork_entry_id,
               child.created_at,
               family.depth + 1
          from sessions child
          join family on child.conversation_parent_session_id = family.id
         where child.tenant_id = ${tenantId}::uuid
           and child.pruned_at is null
           and family.depth < ${MAX_TREE_BRANCHES}
      )
      select id, title, parent_session_id, fork_turn_id, fork_entry_id, depth
        from family
       order by depth, created_at, id
       limit ${MAX_TREE_BRANCHES + 1}
    `.execute(database);
    if (family.rows.length > MAX_TREE_BRANCHES) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Conversation tree has too many branches",
      );
    }
    return family.rows.map((row) => ({
      id: row.id,
      title: row.title,
      parentSessionId: row.parent_session_id,
      forkTurnId: row.fork_turn_id,
      forkEntryId: row.fork_entry_id,
    }));
  }
}
