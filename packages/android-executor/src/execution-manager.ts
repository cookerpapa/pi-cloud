import { isDeepStrictEqual } from "node:util";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
  androidToolDefinitions,
  ANDROID_OPERATION_TIMEOUT_MS,
  type ExecutorBinding,
  type ExecutorOperation,
  type ExecutorCancellation,
  type ExecutorPosition,
  type ToolResultData,
  type ImagePacked,
  type ToolResultPayload,
} from "@pi-cloud/protocol";
import { TOOL_REPLY_TOPIC_PATTERN, type WorkerReply } from "@pi-cloud/event-log";
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
      pack(
        binding: ExecutorBinding,
        result: ToolResultPayload,
        signal: AbortSignal,
      ): Promise<ImagePacked<ToolResultPayload>>;
      publish(topic: string, reply: WorkerReply): Promise<void>;
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
      this.#active?.abort.abort(new Error("Execution binding replaced"));
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
    if (!TOOL_REPLY_TOPIC_PATTERN.test(command.replyTopic))
      throw new ExecutorRefusal("executor_invalid_reply_topic");
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
    this.#authorize(value.binding);
    if (this.#positionAfter(value.position)) this.#position = { ...value.position };
    if (this.#active?.command.operationId === value.operationId)
      this.#active.abort.abort(new Error("Tool cancelled"));
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
    this.#active?.abort.abort(new Error("Binding closed"));
  }
  async #run(active: Active): Promise<void> {
    const call = active.command;
    const signal = AbortSignal.any([
      active.abort.signal,
      AbortSignal.timeout(ANDROID_OPERATION_TIMEOUT_MS),
    ]);
    let reply: WorkerReply;
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
      const packed = await this.options.pack(
        call.binding,
        { toolName: call.toolName, toolCallId: call.nativeCallId, result, isError },
        signal,
      );
      reply = { kind: "tool_result", operationId: call.operationId, sequence: 1, result: packed };
    } catch {
      reply = {
        kind: "execution_failure",
        operationId: call.operationId,
        sequence: 1,
        toolCallId: call.nativeCallId,
        toolName: call.toolName,
        failure: {
          code: "executor_result_unknown",
          effect: "unknown",
          message:
            "The device did not return a confirmed result. The operation may have happened. Inspect its current state before repeating it.",
        },
      };
    }
    // Repeat only the immutable result. Reopening an Appium request would repeat
    // an external action, even if the original HTTP/Kafka receipt was lost.
    const until = Date.now() + 30000;
    do {
      try {
        await this.options.publish(call.replyTopic, reply);
        return;
      } catch {
        if (this.#closed || Date.now() >= until) throw new Error("Result delivery ended");
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
    } while (true);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#active?.abort.abort(new Error("Executor stopped"));
    await this.#active?.work;
  }
}
