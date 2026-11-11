import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  androidToolDefinitions,
  parseExecutorOperation,
  type ExecutorBinding,
  type ExecutorOperation,
  type ExecutorCancellation,
  type ExecutorPosition,
  type ToolResultData,
  type ExecutorCompletion,
} from "@pi-cloud/protocol";
import { AndroidToolError } from "./appium-driver.ts";

export class ExecutorRefusal extends Error {
  constructor(
    readonly code: string,
    readonly effect: "not_started" | "unknown" = "not_started",
  ) {
    super(code);
  }
}
type Active = { command: ExecutorOperation; abort: AbortController; work: Promise<void> };
/** A single screen's destination admission, not a task queue. Process restart
 * changes boot identity; uncertain UI actions are never recovered/re-executed. */
export class AndroidExecutionManager {
  #binding: ExecutorBinding | undefined;
  #closedBinding = false;
  #position: ExecutorPosition | undefined;
  #active: Active | undefined;
  #closed = false;
  readonly #tools = new Map(androidToolDefinitions().map((t) => [t.name, t]));
  constructor(
    readonly options: {
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
  ) {}
  get busy() {
    return Boolean(this.#active);
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
    if (this.#active?.command.operationId === command.operationId) {
      if (!isDeepStrictEqual(command, this.#active.command))
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
    if (this.#active) throw new ExecutorRefusal("executor_busy");
    this.#position = { ...command.position };
    const active: Active = {
      command: structuredClone(command),
      abort: new AbortController(),
      work: Promise.resolve(),
    };
    this.#active = active;
    active.work = Promise.resolve()
      .then(() => this.#run(active))
      .catch(() => this.options.onError?.("executor_reply_unavailable"))
      .finally(() => {
        if (this.#active === active) this.#active = undefined;
      });
    return { accepted: true };
  }
  cancel(value: ExecutorCancellation): void {
    // Recovery keeps the original immutable target. A newer admission generation
    // must not prevent cancelling that exact old action, nor let it cancel a new one.
    const original = this.#active?.command;
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
      this.#active!.abort.abort(new Error("Tool cancelled"));
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
      const result = await this.options
        .execute(call.toolName, call.arguments, signal)
        .catch((error) => {
          if (!(error instanceof AndroidToolError)) throw error;
          isError = true;
          return { content: [{ type: "text" as const, text: error.message }] };
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
    this.#active?.abort.abort(new Error("Executor stopped"));
    await this.#active?.work;
  }
}
