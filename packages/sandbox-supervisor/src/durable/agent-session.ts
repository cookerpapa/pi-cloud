import { withToolInvocation } from "../tool-invocation.ts";
import { PiTurnError } from "../pi-turn-runtime.ts";
import { isDeepStrictEqual } from "node:util";
import {
  parseExecutionReference,
  type CandidateControlToolCommand,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  Harness,
  DEFAULT_COMPACTION_POLICY,
  createRegistry,
  defineExtension,
  defineDoc,
  defineDocFamily,
  configure,
  GenerationTask,
  CompactionTask,
  hook,
  watchEvents,
  type AgentEvent,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Storage,
  type TaskId,
  type ToolRegistration,
  type AgentChange,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
  ScopedDurableModels,
  type CloudModelPermit,
  type CloudModelRequest,
} from "./scoped-models.ts";
import {
  DurableRemoteTools,
  type PreparedRemoteInvocation,
  type RemoteInvocation,
} from "./remote-tools.ts";

export const CloudRunDocument = defineDoc<Record<string, JsonValue>>({
  kind: "pi-cloud.run",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "initial",
  initial: () => ({}),
});
type ConversationCreation = {
  conversationId: number;
  parentConversationId: number;
  ownerTaskId: number;
  at: number | null;
  view: Record<string, JsonValue> | null;
};
const CreationReceipt = defineDocFamily<ConversationCreation, ConversationCreation>({
  kind: "pi-cloud.conversation-creation",
  version: 3,
  scope: "session",
  family: true,
  initial: (receipt) => receipt,
});
const ConversationStop = defineDocFamily<{ stopped: boolean }, boolean>({
  kind: "pi-cloud.conversation-stop",
  version: 1,
  scope: "session",
  family: true,
  initial: (stopped) => ({ stopped }),
});
type HostCallValue = {
  conversationId: number;
  toolName: string;
  callId: string;
  arguments: Record<string, JsonValue>;
};
const HostCallDocument = defineDocFamily<HostCallValue, HostCallValue>({
  kind: "pi-cloud.tool-hostcall",
  version: 1,
  scope: "task",
  family: true,
  initial: (value) => value,
});
export type NativeRequestContext = {
  taskId: number;
  conversationId: number;
  purpose: "agent" | "context_maintenance";
};
export type DurableRunConfiguration = {
  runId: string;
  conversationId: number;
  model: Model<Api>;
  autoCompactTokenLimit?: number;
  agent: Omit<AgentChange, "model" | "tools">;
  context: Record<string, JsonValue>;
  remoteTools: readonly string[];
  tools: readonly ToolRegistration[];
  assertCurrent(): Promise<void>;
  beforeEffect?(signal?: AbortSignal): Promise<void>;
  prepareRemote(invocation: RemoteInvocation): Promise<PreparedRemoteInvocation>;
  openModel(
    request: CloudModelRequest,
    native: NativeRequestContext | undefined,
  ): Promise<CloudModelPermit>;
  beforeYield?: (
    answer: AssistantMessage,
  ) => Promise<import("@earendil-works/pi-durable").UserInput | undefined>;
};

/** Pi owns tasks, retry, compaction and cancellation. This family only supplies
 * cloud ports. Conversations in one root Run have distinct model/Tool bindings. */
export class DurableAgentSession {
  readonly #bindings = new Map<number, DurableRunConfiguration>();
  readonly #conversations = new Map<number, string>();
  readonly #requests = new Map<number, NativeRequestContext>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #abort = new AbortController();
  readonly #registry = createRegistry();
  readonly #installed = new Set<string>();
  readonly #hostCalls = new Map<string, { taskId: number; command: CandidateControlToolCommand }>();
  readonly #models: ScopedDurableModels;
  readonly remote: DurableRemoteTools;
  #harness!: Harness;
  #reserveTokens = DEFAULT_COMPACTION_POLICY.reserveTokens;
  private constructor(
    readonly storage: Storage,
    options: {
      models: Models;
      remoteTools: readonly Omit<ToolRegistration, "execute" | "replay">[];
      infrastructureTools?: readonly ToolRegistration[];
    },
  ) {
    this.#models = new ScopedDurableModels(options.models, async (request) => {
      const run = await this.#awaitRun(
        request.runId,
        request.conversationId,
        request.options.signal,
      );
      await run.assertCurrent();
      await run.beforeEffect?.(request.options.signal);
      return run.openModel(request, this.#requests.get(run.conversationId));
    });
    this.remote = new DurableRemoteTools({
      definitions: options.remoteTools,
      prepare: async (invocation) => {
        const id = this.#conversations.get(invocation.conversationId);
        if (!id) throw new Error("Tool conversation has no cloud Run binding");
        const run = await this.#awaitRun(
          id,
          invocation.conversationId,
          invocation.context.abortSignal,
        );
        await run.assertCurrent();
        await run.beforeEffect?.(invocation.context.abortSignal);
        return run.prepareRemote(invocation);
      },
    });
    for (const definition of this.remote.definitions) this.#installed.add(definition.name);
    this.#registry.install(
      defineExtension({
        name: "pi-cloud-runtime",
        tools: [...this.remote.definitions],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: (_request, api) => {
              this.#requests.set(api.conversationId, {
                taskId: api.taskId,
                conversationId: api.conversationId,
                purpose: "agent",
              });
              return undefined;
            },
            onYield: async (answer, api) => {
              const run = this.#bindings.get(api.conversationId);
              const next = await run?.beforeYield?.(answer);
              return next === undefined ? undefined : { continue: next };
            },
          }),
          hook(CompactionTask, {
            beforeCompact: (_range, api) => {
              this.#requests.set(api.conversationId, {
                taskId: api.taskId,
                conversationId: api.conversationId,
                purpose: "context_maintenance",
              });
              return undefined;
            },
          }),
          this.remote.hook,
        ],
      }),
    );
  }
  #installTools(tools: readonly ToolRegistration[]): void {
    for (const tool of tools) {
      if (this.#installed.has(tool.name)) continue;
      this.#installed.add(tool.name);
      this.#registry.install(
        defineExtension({
          name: `pi-cloud-tool:${tool.name}`,
          tools: [
            {
              ...tool,
              execute: async (args, api, context) => {
                const id = this.#conversations.get(api.conversationId);
                if (!id) throw new Error("Infrastructure Tool has no cloud Run binding");
                const current = await this.#awaitRun(id, api.conversationId, context.abortSignal);
                await current.assertCurrent();
                await current.beforeEffect?.(context.abortSignal);
                const definition = current.tools.find((candidate) => candidate.name === tool.name);
                if (!definition)
                  throw new Error("Infrastructure Tool is unavailable in this conversation");
                return withToolInvocation(
                  { id: `task:${api.taskId}`, nativeToolCallId: api.callId },
                  () => definition.execute(args, api, context),
                );
              },
            },
          ],
        }),
      );
    }
  }
  static async open(
    storage: Storage,
    options: {
      models: Models;
      remoteTools: readonly Omit<ToolRegistration, "execute" | "replay">[];
      infrastructureTools?: readonly ToolRegistration[];
      settings?: HarnessSettings;
      report?: (error: unknown) => void;
    },
  ): Promise<DurableAgentSession> {
    const session = new DurableAgentSession(storage, options);
    session.#reserveTokens =
      options.settings?.compaction?.reserveTokens ?? DEFAULT_COMPACTION_POLICY.reserveTokens;
    session.#installTools(options.infrastructureTools ?? []);
    session.#harness = await Harness.open(
      storage,
      {
        models: session.#models.models,
        registry: session.#registry,
        // Existing product Runs finish when their foreground work finishes. Keep
        // automatic Compaction blocking until independent background admission is exposed.
        settings: {
          ...options.settings,
          compaction: { ...options.settings?.compaction, backgroundTokens: 0 },
        },
        ...(options.report ? { onReport: options.report } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    // Only live task conversations need restored routes. Historical child
    // documents never turn into a lifetime Session bootstrap scan.
    const inspection = await session.#harness.inspect(BACKGROUND_CONTEXT);
    // Compaction resumes summarize/retry without rerunning beforeCompact. The
    // request identity is derived from that committed task, never a new grant.
    // Generation's request phase refreshes this through beforeRequest.
    // Background compaction is disabled,
    // so only one model-producing task can own a Conversation at this boundary.
    for (const { record } of inspection.tasks) {
      if (!("checkpoint" in record.state)) continue;
      const phase = (record.state.checkpoint as { phase?: string }).phase;
      const compaction =
        record.kind === "pi.compaction" && ["summarize", "retry"].includes(phase ?? "");
      if (!compaction) continue;
      session.#requests.set(record.conversationId, {
        taskId: record.id,
        conversationId: record.conversationId,
        purpose: "context_maintenance",
      });
    }
    for (const conversationId of new Set(
      inspection.tasks.map((task) => task.record.conversationId),
    )) {
      const state = await session.#harness.snapshot(
        CloudRunDocument,
        conversationId,
        BACKGROUND_CONTEXT,
      );
      if (typeof state?.runId !== "string" || !state.model) continue;
      session.#conversations.set(conversationId, state.runId);
      session.#models.register(state.runId, conversationId, state.model as unknown as Model<Api>);
    }
    return session;
  }
  get harness(): Harness {
    return this.#harness;
  }
  async bind(run: DurableRunConfiguration): Promise<Conversation> {
    await run.assertCurrent();
    let conversation = await this.#harness.conversation(
      run.conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    if (!conversation && run.conversationId === 1)
      conversation = await this.#harness.root(BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("Native conversation has not been created");
    const previous = await this.#harness.snapshot(
      CloudRunDocument,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (typeof previous?.runId === "string" && previous.runId !== run.runId) {
      const live = await this.#harness.inspect(BACKGROUND_CONTEXT);
      if (live.tasks.some((task) => task.record.conversationId === conversation!.id))
        await conversation.abort(BACKGROUND_CONTEXT);
    }
    const baseEntry =
      previous?.runId === run.runId
        ? (previous.baseEntry ?? null)
        : ((await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? null);
    this.#bindings.set(run.conversationId, run);
    this.#conversations.set(run.conversationId, run.runId);
    this.#installTools(run.tools);
    const descriptor = {
      ...run.model,
      contextWindow:
        run.autoCompactTokenLimit === undefined
          ? run.model.contextWindow
          : Math.min(run.model.contextWindow, run.autoCompactTokenLimit + this.#reserveTokens),
    };
    const model = this.#models.register(run.runId, run.conversationId, descriptor);
    await conversation.commit(async (tx) => {
      const state = await tx.doc(CloudRunDocument, conversation.id);
      for (const key of Object.keys(state)) delete state[key];
      const { headers: _headers, ...modelDescriptor } = descriptor;
      Object.assign(state, run.context, {
        runId: run.runId,
        baseEntry,
        model: JSON.parse(JSON.stringify(modelDescriptor)),
      });
      await configure(tx, conversation.id, {
        ...run.agent,
        model,
        tools: [
          ...this.remote.definitions.filter((tool) => run.remoteTools.includes(tool.name)),
          ...run.tools,
        ],
      });
    }, BACKGROUND_CONTEXT);
    for (const wake of this.#waiters.get(`${run.runId}:${run.conversationId}`) ?? []) wake();
    return conversation;
  }
  detach(runId: string, conversationId: number): void {
    const run = this.#bindings.get(conversationId);
    if (run?.runId === runId) {
      this.#bindings.delete(conversationId);
      this.#conversations.delete(conversationId);
      for (const [taskId, request] of this.#requests)
        if (request.conversationId === conversationId) this.#requests.delete(taskId);
    }
    this.#models.forget(runId, conversationId);
  }
  async watch(
    conversationId: number,
    listener: (events: readonly AgentEvent[], context: Context) => Promise<void>,
  ) {
    const stream = await watchEvents(
      this.#harness,
      conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    stream.start(listener);
    return stream;
  }
  async createConversation(input: {
    requestId: string;
    ownerTaskId: number;
    parentConversationId: number;
    at?: number;
    view?: import("@pi-cloud/protocol").ConversationWorkView;
  }): Promise<number> {
    return this.#harness.commit(async (tx) => {
      const stopped = await this.storage.findDocument(
        { kind: "pi-cloud.conversation-stop", scope: { kind: "session" }, key: input.requestId },
        "current",
        BACKGROUND_CONTEXT,
      );
      if (stopped)
        throw new PiTurnError(
          "native_conversation_cancelled",
          "Native child creation was cancelled",
          false,
        );
      const existing = await this.storage.findDocument(
        {
          kind: "pi-cloud.conversation-creation",
          scope: { kind: "session" },
          key: input.requestId,
        },
        "current",
        BACKGROUND_CONTEXT,
      );
      if (existing) {
        const stored = await this.storage.document(existing.id, "current", BACKGROUND_CONTEXT);
        if (typeof stored?.value.conversationId !== "number")
          throw new Error("Native creation receipt is corrupt");
        if (
          stored.value.ownerTaskId !== input.ownerTaskId ||
          stored.value.parentConversationId !== input.parentConversationId ||
          stored.value.at !== (input.at ?? null) ||
          !isDeepStrictEqual(stored.value.view, input.view ?? null)
        )
          throw new PiTurnError(
            "idempotency_conflict",
            "Native creation identity was reused with different arguments",
            false,
          );
        return stored.value.conversationId;
      }
      const caller = await tx.task(input.ownerTaskId as TaskId);
      const generation = caller?.owner === undefined ? undefined : await tx.task(caller.owner);
      if (
        caller?.kind !== "pi.tool" ||
        caller.abortRequested ||
        ["completing", "terminal"].includes(caller.state.status) ||
        caller.conversationId !== input.parentConversationId ||
        generation?.kind !== "pi.generation" ||
        generation.conversationId !== input.parentConversationId
      )
        throw new PiTurnError(
          "native_conversation_closed",
          "Child creation requires the calling Tool's native generation",
          false,
        );
      // A completing task waits for its owned work. Owning the child under the
      // delegation Tool would prevent the parent from reaching its reply Tool.
      const ownership = { kind: "task" as const, taskId: generation.id };
      const created =
        input.at === undefined
          ? await tx.createConversation({ ownership })
          : await tx.forkConversation(
              input.parentConversationId as ConversationId,
              input.at as EntryId,
              { ownership },
            );
      await tx.doc(CreationReceipt, input.requestId, {
        conversationId: created.id,
        parentConversationId: input.parentConversationId,
        ownerTaskId: input.ownerTaskId,
        at: input.at ?? null,
        view: input.view ? JSON.parse(JSON.stringify(input.view)) : null,
      });
      return created.id;
    }, BACKGROUND_CONTEXT);
  }
  async stopConversation(requestId: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      await tx.doc(ConversationStop, requestId, true);
    }, BACKGROUND_CONTEXT);
    const receipt = await this.#harness.snapshot(CreationReceipt, requestId, BACKGROUND_CONTEXT);
    if (receipt)
      await (
        await this.#harness.conversation(
          receipt.conversationId as ConversationId,
          BACKGROUND_CONTEXT,
        )
      )?.abort(BACKGROUND_CONTEXT);
  }
  async activeConversationViews(
    runId: string,
  ): Promise<
    Array<{ conversationId: number; view: import("@pi-cloud/protocol").ConversationWorkView }>
  > {
    const result: Array<{
      conversationId: number;
      view: import("@pi-cloud/protocol").ConversationWorkView;
    }> = [];
    const inspection = await this.#harness.inspect(BACKGROUND_CONTEXT);
    for (const id of new Set(inspection.tasks.map(({ record }) => record.conversationId))) {
      const value = await this.#harness.snapshot(CloudRunDocument, id, BACKGROUND_CONTEXT);
      if (value?.runId === runId && value.view)
        result.push({
          conversationId: id,
          view: value.view as unknown as import("@pi-cloud/protocol").ConversationWorkView,
        });
    }
    return result;
  }
  async childAnchor(conversationId: number): Promise<number | undefined> {
    const state = await this.#harness.snapshot(
      CloudRunDocument,
      conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    return typeof state?.baseEntry === "number" ? state.baseEntry : undefined;
  }
  preparePublication(commit: DurableSessionCommit) {
    const prepared = this.remote.preparePublication(commit);
    const tools = [...prepared.tools];
    for (const write of commit.writes) {
      if (write.type !== "document.create") continue;
      const record = write.record as { id: number; kind: string; key?: string };
      if (record.kind !== "pi-cloud.tool-hostcall" || !record.key) continue;
      const pending = this.#hostCalls.get(record.key);
      if (!pending) throw new Error("Native hostcall has no prepared dispatch");
      tools.push({
        taskId: pending.taskId,
        command: { ...pending.command, sourceDocumentId: record.id },
      });
    }
    return { ...prepared, tools };
  }
  async publishHostCall(taskId: number, command: CandidateControlToolCommand): Promise<void> {
    const runId = parseExecutionReference(command.executionReference).runId;
    const binding = this.#bindings.get(command.conversationId);
    if (binding?.runId !== runId) throw new Error("Native hostcall invocation has ended");
    await binding.assertCurrent();
    if (this.#hostCalls.has(command.operationId))
      throw new Error("Native hostcall is already publishing");
    this.#hostCalls.set(command.operationId, { taskId, command });
    try {
      await this.#harness.commit(async (tx) => {
        const task = await tx.task(taskId as TaskId);
        if (
          task?.kind !== "pi.tool" ||
          task.conversationId !== command.conversationId ||
          task.abortRequested ||
          task.state.status !== "running" ||
          (task.state.checkpoint as { phase?: string }).phase !== "execute"
        )
          throw new Error("Native hostcall invocation has ended");
        const seed: HostCallValue = {
          conversationId: command.conversationId,
          toolName: command.toolName,
          callId: command.nativeCallId,
          arguments: command.arguments as Record<string, JsonValue>,
        };
        const value = await tx.doc(HostCallDocument, taskId as TaskId, command.operationId, seed);
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(value)), seed))
          throw new Error("Native hostcall identity changed arguments");
      }, BACKGROUND_CONTEXT);
    } finally {
      this.#hostCalls.delete(command.operationId);
    }
  }
  async retireHostCall(taskId: number, id: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const task = await tx.task(taskId as TaskId);
      if (!task || task.state.status === "terminal") return;
      await tx.retireDoc(HostCallDocument, taskId as TaskId, id);
    }, BACKGROUND_CONTEXT);
  }
  async #awaitRun(
    runId: string,
    conversationId: number,
    signal?: AbortSignal,
  ): Promise<DurableRunConfiguration> {
    const id = `${runId}:${conversationId}`;
    while (this.#bindings.get(conversationId)?.runId !== runId) {
      const context = withAbortSignal(
        signal ? AbortSignal.any([signal, this.#abort.signal]) : this.#abort.signal,
        BACKGROUND_CONTEXT,
      );
      let wake!: () => void;
      const ready = new Promise<void>((resolve) => {
        wake = resolve;
      });
      const waiters = this.#waiters.get(id) ?? new Set<() => void>();
      waiters.add(wake);
      this.#waiters.set(id, waiters);
      try {
        await awaitWithContext(ready, context);
      } finally {
        waiters.delete(wake);
        if (!waiters.size) this.#waiters.delete(id);
      }
    }
    this.#abort.signal.throwIfAborted();
    return this.#bindings.get(conversationId)!;
  }
  async close(): Promise<void> {
    this.#abort.abort(new Error("Native Session owner closed"));
    try {
      await this.#harness.close(BACKGROUND_CONTEXT);
    } finally {
      this.remote.close();
      this.#bindings.clear();
      this.#conversations.clear();
      this.#requests.clear();
    }
  }
}
