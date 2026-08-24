import {
  parseToolWorkerInput,
  type ToolWorkerInput,
  type ToolWorkerOutput,
} from "@pi-cloud/protocol";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  initializeToolExecution,
  attachToolExecution,
  executeToolOperation,
  toolOperationFailure,
  ToolWorkerError,
} from "./tool-worker.ts";

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

function envelope(value: unknown): {
  initialization: Extract<ToolWorkerInput, { type: "worker.initialize" }>;
  operation?: Extract<ToolWorkerInput, { type: "worker.operation" }>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (
    (keys.join(",") !== "initialization,mode" &&
      keys.join(",") !== "initialization,mode,operation") ||
    (input.mode !== "initialize" && input.mode !== "operation")
  ) {
    throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
  }
  const initialization = parseToolWorkerInput(input.initialization);
  if (initialization.type !== "worker.initialize") {
    throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
  }
  if (input.mode === "initialize") {
    if (input.operation !== undefined) {
      throw new ToolWorkerError("tool_worker_protocol_error", "Tool worker input was invalid");
    }
    return { initialization };
  }
  const operation = parseToolWorkerInput({
    toolWorkerProtocolVersion: 1,
    type: "worker.operation",
    request: input.operation,
  });
  if (
    operation.type !== "worker.operation" ||
    operation.request.activationId !== initialization.activationId
  ) {
    throw new ToolWorkerError(
      "tool_worker_identity_mismatch",
      "Tool worker identity did not match",
    );
  }
  return { initialization, operation };
}

async function main(): Promise<ToolWorkerOutput> {
  const input = envelope(await readInput(inputPath(process.argv[2])));
  if (input.operation === undefined) {
    const environment = await initializeToolExecution(input.initialization);
    return {
      toolWorkerProtocolVersion: 1,
      type: "worker.ready",
      activationId: input.initialization.activationId,
      environment,
    };
  }
  await attachToolExecution(input.initialization);
  const request = input.operation.request;
  const response = await executeToolOperation(
    request,
    AbortSignal.timeout(request.operation === "bash.exec" ? request.timeoutMs + 1_000 : 60_000),
    input.initialization.webProxy,
  ).catch((error: unknown) => toolOperationFailure(request, error));
  return {
    toolWorkerProtocolVersion: 1,
    type: "worker.operation_result",
    response,
  };
}

try {
  process.stdout.write(`${JSON.stringify(await main())}\n`);
} catch (error: unknown) {
  const failure =
    error instanceof ToolWorkerError
      ? error
      : new ToolWorkerError("tool_worker_failed", "Tool worker failed", true);
  const output: ToolWorkerOutput = {
    toolWorkerProtocolVersion: 1,
    type: "worker.failed",
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
  process.stderr.write(
    `[envd-tool-exec] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
}
