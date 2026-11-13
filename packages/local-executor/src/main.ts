import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DeviceExecutionManager, createExecutorServer } from "@pi-cloud/executor-runtime";
import { localToolDefinitions } from "@pi-cloud/protocol";
import { GuestCompletionClient } from "@pi-cloud/workspace-runtime/tool-completion-client";
import { executeLocalTool } from "./driver.ts";

async function main() {
  if (process.env.PI_CLOUD_LOCAL_EXECUTION_ISOLATED !== "1")
    throw new Error("Use the isolated local executor launcher");
  const targetId = process.env.PI_CLOUD_EXECUTION_TARGET_ID;
  if (!targetId) throw new Error("Local target identity missing");
  const manager = new DeviceExecutionManager({
    kind: "linux",
    tools: localToolDefinitions(),
    targetId,
    bootId: randomUUID(),
    execute: executeLocalTool,
    complete: (call, result) =>
      new GuestCompletionClient(call.completion, call.operationId).complete(result),
    onError: (code) => process.stderr.write(JSON.stringify({ event: code }) + "\n"),
  });
  const server = createExecutorServer({
    token: (await readFile("/run/pma/receiver-token", "utf8")).trim(),
    manager,
    ready: () => true,
  });
  await server.listen({ host: "127.0.0.1", port: Number(process.env.PI_CLOUD_EXECUTOR_PORT) });
  process.stdout.write(
    JSON.stringify({ event: "local_executor_ready", targetId, bootId: manager.options.bootId }) +
      "\n",
  );
  const close = () => {
    void server.close().finally(() => manager.close());
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
void main().catch(() => {
  process.stderr.write("local_executor_failed\n");
  process.exitCode = 1;
});
