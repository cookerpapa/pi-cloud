/** Baseline characterization, not repaired-behavior regression tests.
 * Run: npx vitest run scripts/experiments/kafka-worker-review-20261017/reply-hop.test.ts --maxWorkers=1
 * Only the Kafka driver and image byte source are substituted. No live resources.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { KafkaJS } from "@confluentinc/kafka-javascript";

const f = vi.hoisted(() => ({
  readers: [] as Array<{
    options: import("../../../packages/event-log/src/kafka-partition-reader.ts").PartitionReaderOptions;
  }>,
  assigned: [] as number[],
  batches: [] as Array<(payload: KafkaJS.EachBatchPayload) => Promise<void>>,
  unavailable: false,
  high: "100",
  commit: vi.fn(),
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    CODES: { ERRORS: { ERR__ASSIGN_PARTITIONS: 1 } },
    KafkaJS: {
      logLevel: { NOTHING: 0 },
      Kafka: class {
        admin() {
          return {
            async connect() {},
            async disconnect() {},
            async createTopics() {},
            async deleteTopics() {},
            async listGroups() {
              return { groups: [] };
            },
            async fetchTopicOffsets() {
              if (f.unavailable)
                throw Object.assign(new Error("Injected reply transport outage"), { code: 9999 });
              return [{ partition: 0, low: "0", high: f.high }];
            },
          };
        }
      },
    },
  },
}));
vi.mock("../../../packages/event-log/src/kafka-partition-reader.ts", () => ({
  KafkaPartitionReader: class {
    constructor(
      readonly options: import("../../../packages/event-log/src/kafka-partition-reader.ts").PartitionReaderOptions,
    ) {
      f.readers.push(this);
    }
    async connect() {
      await this.options.rebalance({ code: 1 }, [{ topic: this.options.topic, partition: 0 }], {
        assign: (values) => {
          for (const value of values) f.assigned.push(value.offset!);
        },
        unassign() {},
      });
    }
    async subscribe() {}
    async disconnect() {}
    pause() {}
    seek() {}
    resume() {}
    seedCommitted() {}
    async run(options: { eachBatch: (payload: KafkaJS.EachBatchPayload) => Promise<void> }) {
      f.batches.push(options.eachBatch);
    }
    commitOffset = f.commit;
  },
}));

import { KafkaLogConsumer } from "../../../packages/event-log/src/kafka-log-consumer.ts";
import {
  KafkaToolReplyMailbox,
  ToolReplyMailbox,
  parseWorkerReply,
} from "../../../packages/event-log/src/tool-replies.ts";
import { ImageAttachmentCodec } from "../../../packages/session-attachments/src/codec.ts";
import { decodeSessionImages } from "../../../packages/session-attachments/src/configured.ts";
import { createTrustedRemoteAgentTools } from "../../../packages/sandbox-supervisor/src/trusted-remote-tools.ts";
import { withToolInvocation } from "../../../packages/sandbox-supervisor/src/tool-invocation.ts";
import {
  createExecutionReference,
  type ImageAttachmentReference,
  type ToolResultPayload,
} from "../../../packages/protocol/src/index.ts";

const report: Record<string, unknown> = {
  baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Isolated characterization of real consumer/mailbox/codec/remote Tool adapters. Driver and image store are substituted; no live Kafka, PG, S3, model or Cube mutation.",
};
const closers: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  f.readers = [];
  f.assigned = [];
  f.batches = [];
  f.unavailable = false;
  f.high = "100";
  f.commit.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
afterAll(() =>
  writeFileSync(
    "docs/reports/kafka-worker-reply-review-20261017.json",
    JSON.stringify(report, null, 2) + "\n",
  ),
);

const result: ToolResultPayload = {
  toolCallId: "call",
  toolName: "bash",
  isError: false,
  result: { content: [{ type: "text", text: "complete" }] },
};
const reply = (id: string) =>
  JSON.stringify({ kind: "tool_result", operationId: id, sequence: 1, result });
async function deliver(offset: number, body: string) {
  await f.batches.at(-1)!({
    batch: {
      topic: "reply",
      partition: 0,
      messages: [{ offset: String(offset), value: Buffer.from(body) }],
    },
    isStale: () => false,
    resolveOffset() {},
  } as unknown as KafkaJS.EachBatchPayload);
}

it("characterizes same-boot reconnect rewinding already delivered replies", async () => {
  const mailbox = new ToolReplyMailbox();
  let decoded = 0,
    settled = 0;
  const consumer = new KafkaLogConsumer({
    brokers: ["fixture"],
    topic: "reply",
    clientId: "reply",
    groupId: "reply",
    commitMessages: false,
    decode: (bytes) => {
      decoded++;
      return parseWorkerReply(bytes);
    },
    handler: async ({ fact }) => mailbox.accept(fact),
  });
  closers.push(() => consumer.close());
  await consumer.start();
  await consumer.waitUntilAssigned(1000);
  await vi.waitFor(() => expect(f.batches).toHaveLength(1));
  const first = mailbox
    .wait("old", "call", "bash", new AbortController().signal)
    .then(() => settled++);
  for (let n = 0; n < 100; n++) await deliver(n, reply(n === 99 ? "old" : `retired-${n}`));
  await first;
  f.readers[0]!.options.logger.error("LibrdKafkaError");
  await vi.waitFor(() => expect(f.batches).toHaveLength(2));
  expect(f.assigned).toEqual([0, 0]);
  const next = mailbox
    .wait("new", "call", "bash", new AbortController().signal)
    .then(() => settled++);
  for (let n = f.assigned[1]!; n < 100; n++)
    await deliver(n, reply(n === 99 ? "old" : `retired-${n}`));
  await deliver(100, reply("new"));
  await next;
  expect(decoded).toBe(201);
  expect(settled).toBe(2);
  expect(f.commit).not.toHaveBeenCalled();
  report.reconnect = {
    assignedOffsets: f.assigned,
    firstPassRecords: 100,
    oldRecordsDecodedAgain: decoded - 101,
    callbacksSettled: settled,
    duplicateCallbackDelivery: false,
  };
});

it("characterizes a reply consumer outage without mailbox health or waiter notification", async () => {
  const mailbox = new KafkaToolReplyMailbox({
    brokers: ["fixture"],
    replicas: 3,
    bootId: "10000000-0000-4000-8000-000000000020",
  });
  closers.push(() => mailbox.shutdown());
  await mailbox.start();
  await vi.waitFor(() => expect(f.batches).toHaveLength(1));
  let finished = false;
  const waiting = new AbortController();
  const pending = mailbox.wait("control", "call", "subagent", waiting.signal);
  void pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  f.unavailable = true;
  f.readers[0]!.options.logger.error("LibrdKafkaError");
  await vi.waitFor(() => expect(f.readers.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  expect(finished).toBe(false);
  expect("checkHealth" in mailbox).toBe(false);
  const later = mailbox.wait("new-control", "call", "subagent", waiting.signal);
  expect(mailbox.size).toBe(2);
  report.replyOutage = {
    consumerInstancesObserved: f.readers.length,
    pendingWaitersStillAccepted: mailbox.size,
    healthExposed: false,
    waiterFailedBeforeCancellation: finished,
    limitation:
      "No claim/readiness endpoint was exercised here. Actual runtime's monitor composition was separately inspected in runtime.ts:424-431; it only checks Session publication and provider health.",
  };
  waiting.abort(new Error("fixture cleanup"));
  await expect(pending).rejects.toThrow("fixture cleanup");
  await expect(later).rejects.toThrow("fixture cleanup");
});

const tenantId = "10000000-0000-4000-8000-000000000001",
  runId = "10000000-0000-4000-8000-000000000002";
const bytes = Buffer.from("fixture image bytes");
const reference: ImageAttachmentReference = {
  id: "10000000-0000-4000-8000-000000000003",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.length,
  mimeType: "image/png",
};
async function imageTool(get: (signal?: AbortSignal) => Promise<Buffer>) {
  const mailbox = new ToolReplyMailbox(),
    abort = new AbortController();
  const unavailable = vi.fn(),
    cancellationUnconfirmed = vi.fn(),
    confirm = vi.fn(async () => true);
  const codec = new ImageAttachmentCodec({
    async put() {
      throw new Error("Unexpected upload");
    },
    get: async (_tenant, _ref, signal) => get(signal),
  });
  const turn = "b".repeat(64),
    execution = "e".repeat(64);
  let registeredOperation: string | undefined;
  const tools = createTrustedRemoteAgentTools({
    workflowUrl: "http://fixture.invalid/workflow",
    activationId: "10000000-0000-4000-8000-000000000004",
    executionReference: createExecutionReference(
      "10000000-0000-4000-8000-000000000010",
      "10000000-0000-4000-8000-000000000011",
      1,
    ),
    turnContextSha256: turn,
    executionContextSha256: execution,
    remainingToolCalls: null,
    maximumToolOutputBytes: 65536,
    workingDirectory: "/workspace",
    supportsImages: true,
    onToolOperationUnavailable: unavailable,
    onToolCancellationUnconfirmed: cancellationUnconfirmed,
    confirmExecution: confirm,
    captureStepContext: (activeTools) => {
      const context = {
        schemaVersion: 2 as const,
        sequence: 1,
        turnContextSha256: turn,
        executionContextSha256: execution,
        activeTools: [...activeTools].sort(),
        worldState: {
          sandbox: { status: "inactive" as const, continuitySha256: null },
          environmentSha256: "c".repeat(64),
          workspaceBindingSha256: "f".repeat(64),
          toolPolicySha256: "d".repeat(64),
        },
      };
      return {
        step: {
          context,
          sha256: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
        },
        modelMessages: [],
        samplingAttempt: 1,
      };
    },
    // Same composition as Worker runtime.ts:523-538, with an injected byte store.
    waitForToolReply: async (request, signal, callId) => {
      registeredOperation = request.operationId;
      const packed = await mailbox.wait(request.operationId, callId!, request.toolName, signal);
      return {
        type: "tool_execution_end",
        ...(await decodeSessionImages<ToolResultPayload>(
          codec,
          { tenantId, runId },
          packed,
          signal,
        )),
      };
    },
  });
  const read = tools.tools.find((t) => t.name === "read")!;
  const prepared = await withToolInvocation({ id: "task:1", nativeToolCallId: "read-call" }, () =>
    read.prepareExecution!("read-call", { path: "screenshot.png" }, abort.signal),
  );
  closers.push(() => {
    prepared.dispose();
    mailbox.close();
  });
  const accept = () =>
    mailbox.accept(
      parseWorkerReply(
        JSON.stringify({
          kind: "tool_result",
          operationId: registeredOperation,
          sequence: 1,
          result: {
            toolCallId: "read-call",
            toolName: "read",
            isError: false,
            result: {
              content: [
                { type: "text", text: "Image read completed" },
                { type: "pi_cloud_image_v1", attachment: reference },
              ],
            },
          },
        }),
      ),
    );
  return { mailbox, abort, prepared, unavailable, cancellationUnconfirmed, confirm, accept };
}

it("characterizes attachment failure after a valid final reply as execution UNKNOWN", async () => {
  const storeFailure = new Error("Injected S3 download failure");
  const f = await imageTool(async () => {
    throw storeFailure;
  });
  f.accept();
  const result = f.prepared.result();
  await expect(result).rejects.toMatchObject({
    code: "tool_operation_outcome_unknown",
    effect: "unknown",
    cause: storeFailure,
  });
  expect(f.mailbox.size).toBe(0);
  expect(f.prepared.completed()).toBe(false);
  expect(f.unavailable).toHaveBeenCalledOnce();
  expect(f.confirm).not.toHaveBeenCalled();
  report.attachmentFailure = {
    validFinalReplyReceived: true,
    mailboxWaiters: f.mailbox.size,
    executionCompletedFlag: f.prepared.completed(),
    failureCode: f.unavailable.mock.calls[0]![0].code,
    unavailableCallbackCount: f.unavailable.mock.calls.length,
    readinessProbeCount: f.confirm.mock.calls.length,
    limitation:
      "Proves adapter classification and unavailable callback, not destruction of any physical VM.",
  };
});

it("characterizes Stop during hydration as unconfirmed physical cancellation", async () => {
  let fetching = false;
  const f = await imageTool(
    (signal) =>
      new Promise((_resolve, reject) => {
        fetching = true;
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      }),
  );
  f.accept();
  await vi.waitFor(() => expect(fetching).toBe(true));
  expect(f.mailbox.size).toBe(0);
  expect(f.prepared.completed()).toBe(false);
  const pending = f.prepared.result();
  f.abort.abort(new Error("Stop"));
  f.prepared.dispose();
  await expect(pending).rejects.toThrow("Stop");
  expect(f.cancellationUnconfirmed).toHaveBeenCalledOnce();
  report.stopDuringHydration = {
    validFinalReplyReceived: true,
    imageDownloadPending: true,
    executionCompletedFlag: false,
    cancellationUnconfirmedCount: f.cancellationUnconfirmed.mock.calls.length,
  };
});

it("retains successful images without extra readiness probes", async () => {
  const f = await imageTool(async () => bytes);
  f.accept();
  const result = await f.prepared.result();
  expect(result).toMatchObject({
    content: [
      { type: "text", text: "Image read completed" },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ],
  });
  expect(f.prepared.completed()).toBe(true);
  expect(f.unavailable).not.toHaveBeenCalled();
  expect(f.confirm).not.toHaveBeenCalled();
  report.normalImage = { exactBytesRestored: true, completed: true, readinessProbeCount: 0 };
});
