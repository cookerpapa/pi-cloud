import {
  parseToolWorkerInput,
  type ToolWorkerOutput,
  type NativeToolUpdate,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol/guest";
import { executeAttachedNativeTool } from "./native-tools.ts";
import { toolCancellationInput } from "./tool-cancellation-input.ts";
import { once } from "node:events";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { initializeToolExecution, toolOperationFailure, ToolWorkerError } from "./tool-worker.ts";

const MAXIMUM_INPUT_BYTES = 16 * 1_024 * 1_024;

function inputPath(value: string | undefined): string {
  if (value === undefined || !/^\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json$/u.test(value)) {
    throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input path was invalid");
  }
  return value;
}

async function readInput(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAXIMUM_INPUT_BYTES) {
      throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
    }
    return JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function main(): Promise<ToolWorkerOutput> {
  const input = parseToolWorkerInput(await readInput(inputPath(process.argv[2])));
  if (input.type === "worker.initialize") {
    const environment = await initializeToolExecution(input);
    return {
      toolWorkerProtocolVersion: 6,
      type: "worker.ready",
      activationId: input.activationId,
      environment,
    };
  }
  const request = input.request;
  if (request.activationId !== input.attachment.activationId)
    throw new ToolWorkerError(
      "tool_worker_identity_mismatch",
      "Tool worker identity did not match",
    );
  const control = toolCancellationInput(process.stdin, request.operationId);
  try {
    let sequence = 0;
    let draining: Promise<unknown> | undefined;
    let latest: NativeToolUpdate | undefined;
    const progress = (event: NativeToolUpdate): void => {
      // onUpdate is synchronous in Pi. Keep only the newest progress snapshot
      // while the transport is blocked, never an unbounded stdout write queue.
      if (draining) {
        latest = event;
        return;
      }
      if (
        !process.stdout.write(
          `${JSON.stringify({ operationId: request.operationId, sequence: ++sequence, event })}\n`,
        )
      ) {
        draining = once(process.stdout, "drain").then(() => {
          draining = undefined;
          const event = latest;
          latest = undefined;
          if (event) progress(event);
        });
      }
    };
    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([timeout, control.signal]);
    const execution: Promise<ToolSandboxOperationResponse> = executeAttachedNativeTool(
      request,
      input.attachment,
      signal,
      progress,
    ).then((event) => ({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "tool.execute",
      event,
    }));
    let response = await execution.catch((error: unknown) => toolOperationFailure(request, error));
    let controlFailed = false;
    try {
      control.check();
    } catch {
      controlFailed = true;
      response = toolOperationFailure(
        request,
        new ToolWorkerError(
          "tool_operation_outcome_unknown",
          "Native Tool cancellation transport failed",
          false,
        ),
      );
    }
    while (draining) await draining;
    return {
      toolWorkerProtocolVersion: 6,
      type: "worker.operation_result",
      // Normal Agent cancellation follows Pi's process-group boundary. A setsid
      // child is deliberately outside that boundary; only timeout/fault cleanup
      // requests the stronger whole-operation cgroup cleanup.
      scopeStopRequired: timeout.aborted || controlFailed,
      response,
    };
  } finally {
    control.close();
  }
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error: unknown) {
  const failure =
    error instanceof ToolWorkerError
      ? error
      : new ToolWorkerError("tool_worker_failed", "Tool worker failed", true);
  const output: ToolWorkerOutput = {
    toolWorkerProtocolVersion: 6,
    type: "worker.failed",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
  process.stderr.write(
    `[envd-tool-exec] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
