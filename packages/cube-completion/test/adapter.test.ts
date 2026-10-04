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
      leaseId: writerId,
      fencingToken: 1,
    },
    replyTopic: `pi-cloud.tool-replies.v1.${randomUUID()}`,
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
        toolWorkerProtocolVersion: 3,
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
      event: {
        toolCallId: "native-call",
        result: { content: [{ type: "pi_cloud_image_v1", attachment: { byteLength: 7 } }] },
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
  expect((f.publish.mock.calls[0]![1] as ToolReply).event).toMatchObject({
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
      operationId: f.packet.operationId,
      sequence: 3,
      event: {
        type: "tool_execution_update",
        toolCallId: "native-call",
        toolName: "read",
        args: {},
        partialResult: { content: [{ type: "text", text: "working" }] },
      },
    },
  });
  expect(f.progress.update).toHaveBeenCalledOnce();
  expect(f.progress.update).toHaveBeenCalledWith(
    expect.objectContaining({ progress: expect.objectContaining({ toolCallId: "result-entry" }) }),
  );
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.put).not.toHaveBeenCalled();
});

it("rejects mismatched operation identity and an old guest wire before publication", async () => {
  const f = fixture();
  const raw = f.packet.result!.output as any;
  raw.response.operationId = randomUUID();
  await expect(f.adapter.accept(f.packet)).rejects.toThrow("identity");
  raw.response.operationId = f.packet.operationId;
  raw.toolWorkerProtocolVersion = 1;
  await expect(f.adapter.accept(f.packet)).rejects.toThrow();
  expect(f.publish).not.toHaveBeenCalled();
});

it("marks an unconfirmed scope stop as runtime unavailable without destroying a VM", async () => {
  const f = fixture();
  await f.adapter.accept({
    ...f.packet,
    result: { failure: "tool_scope_stop_unconfirmed", quarantine: true },
  });
  expect((f.publish.mock.calls[0]![1] as ToolReply).event).toMatchObject({
    isError: true,
    result: { content: [{ text: expect.stringContaining("cubesandbox_tool_unavailable") }] },
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
