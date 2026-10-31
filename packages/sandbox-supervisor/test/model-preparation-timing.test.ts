import { afterEach, expect, it, vi } from "vitest";
import type { AnyTask, RegistryReader } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { capturePreparationWork } from "@pi-cloud/observability";
import * as logger from "../../observability/src/logger.ts";
import {
  modelTaskRegistry,
  nativeModelTask,
  finishNativePreparation,
} from "../src/durable/model-task-context.ts";

afterEach(() => vi.restoreAllMocks());
it("observes public native phases without changing their arguments, definition or scheduling", async () => {
  const log = vi.spyOn(logger, "operationalLog").mockImplementation(() => {});
  const wait = Promise.withResolvers<void>();
  const runtime = { taskId: 2, conversationId: 1 },
    task = { private: "never log this" };
  const phases = {
    async prepare(this: unknown, actual: unknown, actor: unknown, context: unknown) {
      expect(this).toBe(phases);
      expect(actual).toBe(task);
      expect(actor).toBe(runtime);
      expect(context).toBe(BACKGROUND_CONTEXT);
      expect(nativeModelTask()).toMatchObject({ taskId: 2, conversationId: 1, purpose: "agent" });
      capturePreparationWork("storage_read")?.({ durationMs: 4, outcome: "completed" });
    },
    async request() {
      finishNativePreparation();
      await wait.promise;
    },
    async retry() {
      expect(capturePreparationWork("storage_read")).toBeUndefined();
    },
  };
  const original = { definition: { name: "pi.generation", phases } } as unknown as AnyTask;
  const snapshot = { task: () => original, tasks: () => [original] };
  const source = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RegistryReader;
  const wrapped = modelTaskRegistry(source, () => ({ runId: "root-run" }));
  const view = wrapped.snapshot();
  expect(wrapped.snapshot()).toBe(view);
  const decorated = view.task("pi.generation")!;
  await (decorated.definition.phases.prepare as Function)(task, runtime, BACKGROUND_CONTEXT);
  const pending = (decorated.definition.phases.request as Function)(
    task,
    runtime,
    BACKGROUND_CONTEXT,
  );
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[0]![0].attributes).toMatchObject({
    stage: "native_context_prepare",
    storage_readCount: 1,
    reachedModel: false,
  });
  expect(log.mock.calls[1]![0].attributes).toMatchObject({
    stage: "native_request_prepare",
    reachedModel: true,
  });
  wait.resolve();
  await pending;
  await (decorated.definition.phases.retry as Function)(task, runtime, BACKGROUND_CONTEXT);
  expect(log).toHaveBeenCalledTimes(2);
  expect(original.definition.phases).toBe(phases);
  expect(JSON.stringify(log.mock.calls)).not.toContain("never log this");
  expect(nativeModelTask()).toBeUndefined();
});
