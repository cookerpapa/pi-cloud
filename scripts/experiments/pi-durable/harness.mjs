import { randomUUID } from "node:crypto";
import {
  Harness,
  createRegistry,
  defineTool,
  defineExtension,
  hook,
  GenerationTask,
  ToolTask,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
export { BACKGROUND_CONTEXT as ctx, fauxAssistantMessage as answer, fauxToolCall as call };

export async function openHarness(
  store,
  { execute, responses, replay, hooks = [], tools = [], modelGuard } = {},
) {
  const faux = fauxProvider({ tokensPerSecond: 1000000 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses ?? [fauxAssistantMessage("DONE")]);
  const registry = createRegistry();
  if (execute)
    tools = [
      defineTool({
        name: "remote",
        description: "A controlled remote Tool probe",
        parameters: Type.Object({ value: Type.String() }),
        ...(replay ? { replay } : {}),
        execute,
      }),
      ...tools,
    ];
  registry.install(defineExtension({ name: "probe", tools, hooks }));
  const modelPort = modelGuard
    ? new Proxy(models, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "streamSimple")
            return (...args) => {
              modelGuard();
              return value.apply(target, args);
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : models;
  const harness = await Harness.open(
    store,
    {
      models: modelPort,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    BACKGROUND_CONTEXT,
  );
  const model = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, root, faux };
}

/** Use public hooks to register a boot-local callback before durable intent.
 * Embed the handoff in that same prepared commit rather than publishing another
 * intent from execute(). The transport endpoint supplies completion separately. */
export function remoteAdapter(endpoint) {
  const calls = new Map();
  const stats = { operations: [], cancellations: [], replies: [], blocked: false };
  return {
    stats,
    guard() {
      if (stats.blocked) throw new Error("pi_cloud_unknown_blocks_sampling");
    },
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name !== "remote") return;
          const operationId = await api.memo("pi-cloud-operation", randomUUID(), context);
          const pending = Promise.withResolvers();
          pending.promise.catch(() => {});
          calls.set(api.taskId, { operationId, call, pending, settled: false, dispatched: false });
          stats.operations.push(operationId);
        },
      }),
      hook(GenerationTask, {
        beforeRequest: () => {
          // Intentional characterization: upstream reports and ignores this
          // exception. The separately tested Models-port guard is the gate.
          if (stats.blocked) throw new Error("pi_cloud_unknown_blocks_sampling");
        },
      }),
    ],
    commands(batch) {
      const commands = [];
      for (const w of batch.writes) {
        if (w.type !== "task" || w.value.kind !== "pi.tool") continue;
        const op = calls.get(w.value.id);
        if (!op) continue;
        if (w.value.abortRequested && op.dispatched && !op.settled && !op.cancelled) {
          op.cancelled = true;
          commands.push({ kind: "cancel", operationId: op.operationId });
        } else if (!op.dispatched && w.value.state.checkpoint?.phase === "execute") {
          op.dispatched = true;
          commands.push({ kind: "submit", operationId: op.operationId, call: op.call });
        }
      }
      return commands;
    },
    async dispatch(command, position) {
      const op = [...calls.values()].find((c) => c.operationId === command.operationId);
      if (!op) return;
      if (command.kind === "cancel") {
        stats.cancellations.push(command.operationId);
        await endpoint.cancel(command.operationId, position);
        return;
      }
      await endpoint.submit({ ...command, position }, (reply) => {
        if (op.settled) return;
        op.settled = true;
        stats.replies.push({ operationId: command.operationId, effect: reply.effect });
        if (reply.effect === "unknown") stats.blocked = true;
        op.pending.resolve(reply);
      });
    },
    async execute(_args, api) {
      const op = calls.get(api.taskId);
      if (!op) throw new Error("Original boot callback is unavailable");
      const reply = await op.pending.promise;
      return {
        content: reply.content ?? [{ type: "text", text: reply.text }],
        isError: reply.isError ?? false,
        details: { operationId: op.operationId, effect: reply.effect },
        ...(reply.effect === "unknown" ? { control: { terminate: true } } : {}),
      };
    },
  };
}
