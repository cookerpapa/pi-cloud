import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { executeNativeTool } from "../../../packages/tool-sandbox/src/native-tools.ts";
const dir = await mkdtemp(join(tmpdir(), "pi-cloud-review-read-"));
try {
  const text = "IMPORTANT_PREFIX_" + "x".repeat(120000);
  await writeFile(join(dir, "bundle.js"), text);
  const args = { path: "bundle.js" };
  const native = await createReadTool().execute(
    args,
    { env: new NodeExecutionEnv({ cwd: dir }), diagnostic: () => {} },
    BACKGROUND_CONTEXT,
  );
  const cloud = await executeNativeTool(
    {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      operation: "tool.execute",
      activationId: randomUUID(),
      operationId: randomUUID(),
      toolCallId: "review",
      toolName: "read",
      args,
      timeoutMs: 1000,
      maximumOutputBytes: 51200,
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      stepContextSequence: 1,
      stepContextSha256: "c".repeat(64),
    },
    dir,
    new AbortController().signal,
    () => {},
  );
  const content = (x) =>
    (x.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  const result = {
    bytes: Buffer.byteLength(text),
    native: {
      contentBytes: Buffer.byteLength(content(native)),
      containsFilePrefix: content(native).startsWith("IMPORTANT_PREFIX_"),
      diagnostics: native.diagnostics,
    },
    cloud: {
      contentBytes: Buffer.byteLength(content(cloud.result)),
      containsFilePrefix: content(cloud.result).startsWith("IMPORTANT_PREFIX_"),
      isError: cloud.isError,
      text: content(cloud.result),
    },
  };
  assert.equal(result.native.contentBytes, 51200);
  assert(result.native.containsFilePrefix);
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-read-parity.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await rm(dir, { recursive: true, force: true });
}
