import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import type { AnyTask, RegistryReader, RegistrySnapshot } from "@earendil-works/pi-durable";
import {
  startRunPreparation,
  type RunPreparationTiming,
  type PiCloudMetrics,
} from "@pi-cloud/observability";

export type NativeRequestContext = Readonly<{
  taskId: number;
  conversationId: number;
  purpose: "agent" | "context_maintenance";
}>;

const current = new AsyncLocalStorage<
  { native: NativeRequestContext; preparation?: RunPreparationTiming } | undefined
>();
export const nativeModelTask = (): NativeRequestContext | undefined => current.getStore()?.native;
/** Called at the public Models port, before cloud admission or provider I/O. */
export function finishNativePreparation(): void {
  const preparation = current.getStore()?.preparation;
  if (!preparation) return;
  if (preparation.options.details) preparation.options.details.reachedModel = true;
  preparation.finish("completed");
}
type Phase = (
  task: unknown,
  runtime: { taskId: number; conversationId: number },
  context: Context,
) => Promise<void>;

/** Instrument the public task invocation boundary, including reopened phases.
 * All native phase functions, state transitions and checkpoint shapes are retained.
 * Never mutate Pi's exported task definitions or inspect its private scheduler. */
export function modelTaskRegistry(
  source: RegistryReader,
  timingOwner?: (conversationId: number) => { runId: string; metrics?: PiCloudMetrics } | undefined,
): RegistryReader {
  const snapshots = new WeakMap<RegistrySnapshot, RegistrySnapshot>();
  const tasks = new WeakMap<AnyTask, AnyTask>();
  const decorate = (task: AnyTask): AnyTask => {
    const name = task.definition.name;
    const modelTask = name === "pi.generation" || name === "pi.compaction";
    const existing = tasks.get(task);
    if (existing) return existing;
    const wrapped = {
      ...task,
      definition: {
        ...task.definition,
        phases: Object.fromEntries(
          Object.entries(task.definition.phases as Record<string, Phase>).map(([phase, run]) => [
            phase,
            (...args: Parameters<typeof run>) => {
              const value: NativeRequestContext | undefined = modelTask
                ? {
                    taskId: args[1].taskId,
                    conversationId: args[1].conversationId,
                    purpose: name === "pi.generation" ? "agent" : "context_maintenance",
                  }
                : undefined;
              let owner: ReturnType<NonNullable<typeof timingOwner>>;
              try {
                owner = value && timingOwner?.(value.conversationId);
              } catch {
                /* diagnostics only */
              }
              const preparation =
                owner && value && ["prepare", "request", "select", "summarize"].includes(phase)
                  ? startRunPreparation(
                      owner.runId,
                      phase === "prepare" || phase === "select"
                        ? "native_context_prepare"
                        : "native_request_prepare",
                      owner.metrics,
                      {
                        ...(args[2].abortSignal ? { signal: args[2].abortSignal } : {}),
                        details: {
                          taskId: value.taskId,
                          conversationId: value.conversationId,
                          purpose: value.purpose,
                          nativePhase: phase as "prepare" | "request" | "select" | "summarize",
                          reachedModel: false,
                        },
                      },
                    )
                  : undefined;
              const invoke = () => run.apply(task.definition.phases, args);
              return current.run(
                value ? { native: value, ...(preparation ? { preparation } : {}) } : undefined,
                () => (preparation ? preparation.run(invoke) : invoke()),
              );
            },
          ]),
        ),
      },
    } as AnyTask;
    tasks.set(task, wrapped);
    return wrapped;
  };
  return {
    subscribe: (listener) => source.subscribe(listener),
    snapshot: () => {
      const snapshot = source.snapshot();
      const existing = snapshots.get(snapshot);
      if (existing) return existing;
      const result: RegistrySnapshot = {
        installed: () => snapshot.installed(),
        extension: (name) => snapshot.extension(name),
        tools: () => snapshot.tools(),
        sections: () => snapshot.sections(),
        tasks: () => snapshot.tasks().map(decorate),
        task: (name) => {
          const task = snapshot.task(name);
          return task ? decorate(task) : undefined;
        },
      };
      snapshots.set(snapshot, result);
      return result;
    },
  };
}
