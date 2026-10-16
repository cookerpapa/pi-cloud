import type { ToolReply } from "@pi-cloud/event-log";
import { randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import { CubeCompletionAdapter, type CompletionPacket } from "../src/adapter.ts";

function fixture() {
  const operationId = randomUUID(),
    writerId = randomUUID();
  const context: CompletionPacket["context"] = {
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      piSessionId: randomUUID(),
      runId: randomUUID(),
      turnId: randomUUID(),
      writerId,
      fencingToken: 1,
    },
    replyTopic: `pi-cloud.tool-replies.v3.${randomUUID()}`,
    toolCallId: "result-entry",
    nativeToolCallId: "native-call",
    toolName: "read",
    partition: 0,
  };
  const packet: CompletionPacket = {
    id: randomUUID(),
    kind: "result",
    operationId,
    context,
    result: {
      output: {
        toolWorkerProtocolVersion: 7,
        type: "worker.operation_result",
        scopeStopRequired: false,
        response: {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: randomUUID(),
          operationId,
          operation: "tool.execute",
          event: {
            type: "tool_execution_end",
            toolName: "read",
            toolCallId: "native-call",
            isError: false,
            result: {
              diagnostics: [{ severity: "info", code: "fixture", message: "Guest diagnostic" }],
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.from("picture").toString("base64"),
                },
              ],
            },
          },
        },
      },
    },
  };
  const publish = vi.fn<CubeCompletionAdapter["options"]["publish"]>(async () => {});
  const progress = { update: vi.fn(), forget: vi.fn() };
  const put = vi.fn<ImageAttachmentCodec["store"]["put"]>(async (_scope, bytes, mimeType) => ({
    id: randomUUID(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    mimeType,
  }));
  const images = new ImageAttachmentCodec({ put, get: async () => Buffer.from("picture") });
  const adapter = new CubeCompletionAdapter({ images, publish, progress });
  return { packet, context, adapter, put, publish, progress };
}

it.each([
  ["tool_cancelled_before_start", "not_started"],
  ["tool_cancelled", "unknown"],
  ["read_capacity_timeout", "not_started"],
] as const)(
  "keeps native pre-start and in-flight interruption distinct: %s",
  async (code, effect) => {
    const f = fixture();
    await f.adapter.accept({ ...f.packet, result: { failure: code } });
    expect(f.publish.mock.calls[0]![1]).toMatchObject({
      kind: "execution_failure",
      failure: { effect },
    });
    const reply = f.publish.mock.calls[0]![1] as Extract<ToolReply, { kind: "execution_failure" }>;
    if (effect === "not_started") expect(reply.failure.message).toContain("did not start");
    else expect(reply.failure.message).toContain("inspect effects");
  },
);

it("externalizes the guest image before the boot reply and preserves the original callback identity", async () => {
  const f = fixture();
  await f.adapter.accept(f.packet);
  expect(f.put).toHaveBeenCalledWith(
    { tenantId: f.context.scope.tenantId, runId: f.context.scope.runId },
    Buffer.from("picture"),
    "image/png",
    undefined,
  );
  expect(f.publish.mock.calls[0]).toMatchObject([
    f.context.replyTopic,
    {
      operationId: f.packet.operationId,
      sequence: 1,
      result: {
        toolCallId: "native-call",
        result: {
          content: [{ type: "pi_cloud_image_v1", attachment: { byteLength: 7 } }],
          diagnostics: [{ severity: "info", code: "fixture", message: "Guest diagnostic" }],
        },
      },
    },
  ]);
  expect(JSON.stringify(f.publish.mock.calls)).not.toContain(
    Buffer.from("picture").toString("base64"),
  );
});

it("retries only immutable reply delivery when the publisher loses its acknowledgement", async () => {
  const f = fixture();
  f.publish.mockRejectedValueOnce(new Error("Kafka reply ACK lost"));
  await expect(f.adapter.accept(f.packet)).rejects.toThrow("ACK lost");
  await f.adapter.accept(f.packet);
  expect(f.publish).toHaveBeenCalledTimes(2);
  expect(f.put).toHaveBeenCalledOnce();
  expect(f.publish.mock.calls[0]).toEqual(f.publish.mock.calls[1]);
});

it("reports failed image storage without inserting an inline image or invented visual result", async () => {
  const f = fixture();
  f.put.mockRejectedValueOnce(new Error("object store unavailable"));
  await f.adapter.accept(f.packet);
  expect(
    (f.publish.mock.calls[0]![1] as Extract<ToolReply, { kind: "tool_result" }>).result,
  ).toMatchObject({
    isError: true,
    result: {
      content: [{ type: "text", text: expect.stringContaining("image_attachment_upload_failed") }],
    },
  });
});

it("keeps progress lossy and outside the final-result channel", async () => {
  const f = fixture();
  await f.adapter.accept({
    ...f.packet,
    kind: "progress",
    output: {
      type: "worker.preview",
      operationId: f.packet.operationId,
      toolCallId: "native-call",
      toolName: "read",
      update: { kind: "reset", revision: 3, text: "working" },
    },
  });
  expect(f.progress.update).toHaveBeenCalledOnce();
  expect(f.progress.update).toHaveBeenCalledWith(
    expect.objectContaining({ progress: expect.objectContaining({ toolCallId: "result-entry" }) }),
  );
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
});

it("preserves a known directory failure as a final native Tool result", async () => {
  const f = fixture();
  const output = f.packet.result!.output as any;
  output.response.event = {
    type: "tool_execution_end",
    toolCallId: "native-call",
    toolName: "read",
    isError: true,
    result: { content: [{ type: "text", text: "tool_root_unavailable: This Tool did not run." }] },
  };
  await f.adapter.accept(f.packet);
  expect(f.publish.mock.calls[0]![1]).toMatchObject({
    kind: "tool_result",
    operationId: f.packet.operationId,
    result: { toolCallId: "native-call", isError: true, result: output.response.event.result },
  });
  expect(f.put).not.toHaveBeenCalled();
});

it.each(["workspace_attach_invalid", "tool_worker_failed"])(
  "keeps guest infrastructure failure uncertain: %s",
  async (code) => {
    const f = fixture();
    f.packet.result!.output = {
      toolWorkerProtocolVersion: 7,
      type: "worker.failed",
      code,
      message: "Guest preparation failed",
      retryable: false,
    };
    await f.adapter.accept(f.packet);
    expect(f.publish.mock.calls[0]![1]).toMatchObject({
      kind: "execution_failure",
      failure: { code, effect: "unknown" },
    });
  },
);

it("returns a blocking protocol failure for mismatched identity or old guest wire", async () => {
  const f = fixture();
  const raw = f.packet.result!.output as any;
  raw.response.operationId = randomUUID();
  await f.adapter.accept(f.packet);
  raw.response.operationId = f.packet.operationId;
  raw.toolWorkerProtocolVersion = 3;
  await f.adapter.accept(f.packet);
  expect(f.publish).toHaveBeenCalledTimes(2);
  for (const [, reply] of f.publish.mock.calls)
    expect(reply).toMatchObject({
      kind: "execution_failure",
      failure: {
        code: "tool_reply_protocol_error",
        effect: "unknown",
      },
    });
});

it("marks an unconfirmed scope stop as runtime unavailable without destroying a VM", async () => {
  const f = fixture();
  await f.adapter.accept({
    ...f.packet,
    result: { failure: "tool_scope_stop_unconfirmed", quarantine: true },
  });
  expect(f.publish.mock.calls[0]![1]).toMatchObject({
    kind: "execution_failure",
    failure: { code: "cubesandbox_tool_unavailable", effect: "unknown" },
  });
});

it("publishes one distinct probe reply for shared VM bindings without Tool or image work", async () => {
  const f = fixture(),
    probeId = randomUUID(),
    bindingIds = [randomUUID(), randomUUID()];
  const context: CompletionPacket["context"] = {
    kind: "execution_probe",
    replyTopic: f.context.replyTopic,
    sentAt: Date.now(),
    bindingIds,
    execution: { bindingId: bindingIds[0]!, targetId: "physical-target", bootId: randomUUID() },
  };
  const packet: CompletionPacket = {
    kind: "result",
    operationId: probeId,
    context,
    result: { output: { type: "worker.probe_result", probeId, guestBootId: randomUUID() } },
  };
  await f.adapter.accept(packet);
  expect(f.publish).toHaveBeenCalledWith(
    context.replyTopic,
    expect.objectContaining({ kind: "execution_probe", probeId, bindingIds }),
  );
  expect(f.put).not.toHaveBeenCalled();
  expect(f.progress.update).not.toHaveBeenCalled();
  await expect(
    f.adapter.accept({ ...packet, result: { failure: "probe_expired" } }),
  ).rejects.toThrow();
  await expect(f.adapter.accept({ ...packet, operationId: randomUUID() })).rejects.toThrow(
    "identity",
  );
  expect(f.publish).toHaveBeenCalledOnce();
});

it("only actual native guest completion supplies physical execution evidence", async () => {
  const f = fixture();
  f.context.execution = { bindingId: randomUUID(), targetId: "target", bootId: randomUUID() };
  await f.adapter.accept(f.packet);
  expect(f.publish.mock.calls[0]![1]).toMatchObject({
    execution: { ...f.context.execution, observedAt: expect.any(Number) },
  });
  await f.adapter.accept({ ...f.packet, result: { failure: "execution_not_started" } });
  expect(f.publish.mock.calls[1]![1]).not.toHaveProperty("execution");
});
