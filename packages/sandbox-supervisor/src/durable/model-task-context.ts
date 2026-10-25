import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord";
import type { AnyTask, RegistryReader, RegistrySnapshot } from "@earendil-works/pi-durable";

export type NativeRequestContext = Readonly<{
  taskId: number;
  conversationId: number;
  purpose: "agent" | "context_maintenance";
}>;

const current = new AsyncLocalStorage<NativeRequestContext | undefined>();
export const nativeModelTask = (): NativeRequestContext | undefined => current.getStore();
type Phase = (
  task: unknown,
  runtime: { taskId: number; conversationId: number },
  context: Context,
) => Promise<void>;

/** Instrument the public task invocation boundary, including reopened phases.
 * All native phase functions, state transitions and checkpoint shapes are retained.
 * Never mutate Pi's exported task definitions or inspect its private scheduler. */
export function modelTaskRegistry(source: RegistryReader): RegistryReader {
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
            (...args: Parameters<typeof run>) =>
              current.run(
                modelTask
                  ? {
                      taskId: args[1].taskId,
                      conversationId: args[1].conversationId,
                      purpose: name === "pi.generation" ? "agent" : "context_maintenance",
                    }
                  : undefined,
                () => run.apply(task.definition.phases, args),
              ),
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
