import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  type ControlToolCatalogDefinition,
  parseExecutorOperation,
  type ExecutorBinding,
  type ExecutorOperation,
  type ExecutorCancellation,
  type ExecutorPosition,
  type ToolResultData,
  type ExecutorCompletion,
} from "@pi-cloud/protocol";
export class ExecutorToolError extends Error {
  constructor(
    message: string,
    readonly result?: ToolResultData,
  ) {
    super(message);
  }
}

export class ExecutorRefusal extends Error {
  constructor(
    readonly code: string,
    readonly effect: "not_started" | "unknown" = "not_started",
  ) {
    super(code);
  }
}
type Active = { command: ExecutorOperation; abort: AbortController; work: Promise<void> };
/** Destination admission, not a task queue. Android serializes screen actions;
 * Linux operations keep individual cancellation. Restart changes boot identity. */
export class DeviceExecutionManager {
  #binding: ExecutorBinding | undefined;
  #closedBinding = false;
  #position: ExecutorPosition | undefined;
  readonly #active = new Map<string, Active>();
  #closed = false;
  #operationsStarted = 0;
  readonly #tools: Map<string, ControlToolCatalogDefinition>;
  constructor(
    readonly options: {
      kind: "android" | "linux";
      tools: readonly ControlToolCatalogDefinition[];
      ready?(): boolean;
      targetId: string;
      bootId: string;
      execute(
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<ToolResultData>;
      complete(command: ExecutorOperation, output: ExecutorCompletion): Promise<void>;
      onError?(code: string): void;
    },
  ) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }
  get capabilities() {
    return [
      ...new Set(
        this.options.tools.flatMap((tool) =>
          tool.environment?.kind === "target" ? tool.environment.capabilities : [],
        ),
      ),
    ];
  }
  get busy() {
    return this.#active.size > 0;
  }
  get operationsStarted() {
    return this.#operationsStarted;
  }
  #authorize(binding: ExecutorBinding): void {
    if (this.#closed) throw new ExecutorRefusal("executor_stopping");
    if (binding.targetId !== this.options.targetId || binding.bootId !== this.options.bootId)
      throw new ExecutorRefusal("executor_replaced");
    if (!this.#binding || BigInt(binding.generation) > BigInt(this.#binding.generation)) {
      this.#binding = structuredClone(binding);
      this.#closedBinding = false;
      this.#position = undefined;
    } else if (BigInt(binding.generation) < BigInt(this.#binding.generation))
      throw new ExecutorRefusal("executor_binding_stale");
    else if (!isDeepStrictEqual(binding, this.#binding))
      throw new ExecutorRefusal("executor_binding_changed");
    if (this.#closedBinding) throw new ExecutorRefusal("executor_binding_closed");
  }
  #positionAfter(position: ExecutorPosition): boolean {
    if (!this.#position) return true;
    if (position.topic !== this.#position.topic || position.partition !== this.#position.partition)
      throw new ExecutorRefusal("executor_source_changed");
    return (
      BigInt(position.offset) > BigInt(this.#position.offset) ||
      (position.offset === this.#position.offset && position.index > this.#position.index)
    );
  }
  submit(command: ExecutorOperation): { accepted: true } {
    try {
      parseExecutorOperation(command);
    } catch {
      throw new ExecutorRefusal("executor_invalid_completion");
    }
    if (command.deadlineAt <= Date.now()) throw new ExecutorRefusal("executor_deadline_elapsed");
    if (this.options.ready && !this.options.ready())
      throw new ExecutorRefusal("executor_unavailable");
    this.#authorize(command.binding);
    const duplicate = this.#active.get(command.operationId);
    if (duplicate) {
      if (!isDeepStrictEqual(command, duplicate.command))
        throw new ExecutorRefusal("executor_operation_changed");
      return { accepted: true };
    }
    if (!this.#positionAfter(command.position))
      throw new ExecutorRefusal("executor_position_stale", "unknown");
    const tool = this.#tools.get(command.toolName);
    if (
      !tool ||
      tool.environment.kind !== "target" ||
      !tool.environment.capabilities.every((c) => command.binding.capabilities.includes(c))
    )
      throw new ExecutorRefusal("executor_tool_unavailable");
    if (!Value.Check(tool.parameters as TSchema, command.arguments))
      throw new ExecutorRefusal("executor_invalid_arguments");
    if (this.options.kind === "android" && this.#active.size)
      throw new ExecutorRefusal("executor_busy");
    this.#position = { ...command.position };
    const active: Active = {
      command: structuredClone(command),
      abort: new AbortController(),
      work: Promise.resolve(),
    };
    this.#active.set(command.operationId, active);
    active.work = Promise.resolve()
      .then(() => this.#run(active))
      .catch(() => this.options.onError?.("executor_reply_unavailable"))
      .finally(() => {
        if (this.#active.get(command.operationId) === active)
          this.#active.delete(command.operationId);
      });
    return { accepted: true };
  }
  cancel(value: ExecutorCancellation): void {
    // Recovery keeps the original immutable target. A newer admission generation
    // must not prevent cancelling that exact old action, nor let it cancel a new one.
    const active = this.#active.get(value.operationId);
    const original = active?.command;
    if (
      original &&
      original.operationId === value.operationId &&
      isDeepStrictEqual(original.binding, value.binding)
    ) {
      const p = original.position,
        q = value.position;
      if (
        p.topic !== q.topic ||
        p.partition !== q.partition ||
        BigInt(q.offset) < BigInt(p.offset) ||
        (q.offset === p.offset && q.index <= p.index)
      )
        throw new ExecutorRefusal("executor_cancel_position_stale");
      if (isDeepStrictEqual(this.#binding, value.binding) && this.#positionAfter(q))
        this.#position = { ...q };
      active!.abort.abort(new Error("Tool cancelled"));
      return;
    }
    this.#authorize(value.binding);
    if (this.#positionAfter(value.position)) this.#position = { ...value.position };
  }
  closeBinding(binding: ExecutorBinding): void {
    try {
      this.#authorize(binding);
    } catch (error) {
      if (
        error instanceof ExecutorRefusal &&
        ["executor_replaced", "executor_binding_stale", "executor_binding_closed"].includes(
          error.code,
        )
      )
        return;
      throw error;
    }
    this.#closedBinding = true;
  }
  async #run(active: Active): Promise<void> {
    const call = active.command;
    const signal = AbortSignal.any([
      active.abort.signal,
      AbortSignal.timeout(Math.max(1, call.deadlineAt - Date.now())),
    ]);
    let reply: ExecutorCompletion;
    try {
      signal.throwIfAborted();
      let isError = false;
      this.#operationsStarted++;
      const result = await this.options
        .execute(call.toolName, call.arguments, signal)
        .catch((error) => {
          if (!(error instanceof ExecutorToolError)) throw error;
          isError = true;
          return error.result ?? { content: [{ type: "text" as const, text: error.message }] };
        });
      signal.throwIfAborted();
      reply = {
        type: "executor.result",
        result: { toolName: call.toolName, toolCallId: call.nativeCallId, result, isError },
      };
    } catch {
      reply = { type: "executor.unknown" };
    }
    // The shared HTTPS client retries only this immutable result through its
    // original absolute deadline. It never reopens an Appium action.
    await this.options.complete(call, reply);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort.abort(new Error("Executor stopped"));
    await Promise.allSettled([...this.#active.values()].map((active) => active.work));
  }
}
