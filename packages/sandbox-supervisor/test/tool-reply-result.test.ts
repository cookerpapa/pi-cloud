import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  MemoryStorage,
  type Seq,
  type StorageWrite,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { FakeModelServer, FAKE_MODEL_API_KEY } from "@pi-cloud/fake-model-server";
import { ToolReplyMailbox, parseWorkerReply } from "@pi-cloud/event-log";
import { ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import {
  PiSessionWorldStateController,
  RemoteToolSandboxTurnRunner,
} from "@pi-cloud/sandbox-supervisor";
import type { TrustedModelRuntimeLease } from "../src/agent-turn-runtime.ts";
import type {
  DurableSessionHandle,
  ManagedNativeRuntime,
} from "@pi-cloud/pi-session-postgres/durable";
import {
  type CandidateToolCommand,
  type DurableSessionCommit,
  type ToolResultPayload,
  type ToolReplyWait,
} from "@pi-cloud/protocol";
import { command } from "./fixtures/durable-command.ts";
import { nativeTestDisplay } from "./fixtures/native-test-display.ts";
import { restoreToolReply } from "../../supervisor-host/src/tool-reply-result.ts";

const pixels = Buffer.from("immutable image fixture");
const imageReference = {
  id: "10000000-0000-4000-8000-000000000003",
  sha256: createHash("sha256").update(pixels).digest("hex"),
  byteLength: pixels.length,
  mimeType: "image/png" as const,
};
const entriesQuery = { conversationId: 1 as ConversationId };
type Mode =
  | "success"
  | "download_error"
  | "metadata_error"
  | "integrity_error"
  | "stop"
  | "receipt_deadline"
  | "stop_after_failure"
  | "lease_after_failure"
  | "writer_after_failure";

async function fixture(mode: Mode) {
  const fake = new FakeModelServer({ defaultScenario: "tool_hold" });
  await fake.start();
  const directory = await mkdtemp(join(tmpdir(), "worker-reply-image-"));
  const stop = new AbortController(),
    authority = new AbortController(),
    mailbox = new ToolReplyMailbox();
  const fetching = Promise.withResolvers<void>(),
    imageGate = Promise.withResolvers<void>();
  const waits: ToolReplyWait<ToolResultPayload>[] = [];
  const commands: CandidateToolCommand[] = [],
    cancellations: string[] = [];
  const codec = new ImageAttachmentCodec({
    async put() {
      throw new Error("Unexpected image upload");
    },
    async get(_tenant, _reference, signal) {
      fetching.resolve();
      if (mode === "download_error" || mode === "metadata_error" || mode.endsWith("_after_failure"))
        throw new Error("PRIVATE_ATTACHMENT_BACKEND_DETAIL");
      if (mode === "stop" || mode === "receipt_deadline") {
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal!.reason);
          signal!.addEventListener("abort", aborted, { once: true });
          void imageGate.promise.then(() => {
            signal!.removeEventListener("abort", aborted);
            resolve();
          });
          if (signal!.aborted) aborted();
        });
      }
      return mode === "integrity_error" ? Buffer.from("bad bytes") : pixels;
    },
  });
  const display = nativeTestDisplay(() => {}),
    recordSeq = new Map<number, number>();
  let prepare: Parameters<DurableSessionHandle["preparePublication"]>[0] | undefined;
  let runtime: Promise<ManagedNativeRuntime> | undefined;
  let interruptedAfterFailure = false;
  const reply = (tool: CandidateToolCommand) =>
    parseWorkerReply(
      JSON.stringify({
        kind: "tool_result",
        operationId: tool.request.operationId,
        sequence: 1,
        result: {
          toolCallId:
            tool.request.operation === "tool.execute" ? tool.request.toolCallId : "workflow",
          toolName: tool.request.toolName,
          isError: false,
          result: {
            content: [
              { type: "text", text: "Tool finished" },
              { type: "pi_cloud_image_v1", attachment: imageReference },
            ],
          },
        },
      }),
    );
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      return display.serializePublication(async () => {
        const pending = this.prepareCommit(writes);
        const text = await display.compile(this, pending.writes, pending.seq);
        const effects = prepare?.({
          seq: pending.seq,
          nextId: 10000,
          writes: pending.writes,
        } as unknown as DurableSessionCommit);
        effects?.confirmed();
        const seq = pending.apply();
        text();
        for (const write of writes)
          recordSeq.set(
            "value" in write ? write.value.id : "record" in write ? write.record.id : write.id,
            seq,
          );
        for (const item of effects?.tools ?? []) {
          if (!("request" in item.command)) throw new Error("Expected fixed Tool");
          commands.push(item.command);
          // Fast final delivery before the original Storage.commit caller resumes.
          mailbox.accept(reply(item.command));
        }
        for (const cancel of effects?.cancellations ?? []) cancellations.push(cancel.operationId);
        if (
          !interruptedAfterFailure &&
          mode.endsWith("_after_failure") &&
          JSON.stringify(writes).includes("tool_result_attachment_unavailable")
        ) {
          interruptedAfterFailure = true;
          if (mode === "stop_after_failure")
            stop.abort({
              kind: "pi-cloud.turn-cancellation",
              reason: "user_request",
              gracePeriodMs: 1000,
            });
          else
            authority.abort(
              Object.assign(new Error("Owner ended after diagnostic"), {
                code:
                  mode === "writer_after_failure"
                    ? "writer_publication_failed"
                    : "session_lease_revoked",
              }),
            );
        }
        await Promise.resolve();
        return seq;
      });
    }
  })();
  const handle: DurableSessionHandle = {
    ...display,
    storage,
    binding: {
      tenantId: command.payload.tenantId,
      sessionId: command.payload.sessionId,
      piSessionId: command.payload.piSession.id,
      conversationId: 1,
      runId: command.payload.runId,
      turnId: command.payload.turnId,
      writerId: command.payload.piSession.writerId,
      executionReference: command.payload.executionReference,
    },
    recordSequence: async (id) => recordSeq.get(id),
    committedSequence: () => Math.max(0, ...recordSeq.values()),
    authority: {
      signal: authority.signal,
      assertCurrent: async () => authority.signal.throwIfAborted(),
      close: async () => {},
    },
    interrupt: (reason) => authority.abort(reason),
    runtime: (factory) => (runtime ??= factory()) as ReturnType<typeof factory>,
    preparePublication: (value) => {
      prepare = value;
    },
    close: async () => {},
  };
  const activationId = randomUUID();
  const release = vi.fn(async () => ({ retained: true }));
  const runner = new RemoteToolSandboxTurnRunner({
    trustedWorkspaceDirectory: directory,
    runtimeIdentity: { supervisorId: "fixture", sandboxId: "fixture", bootId: randomUUID() },
    broker: {
      create: async (request) => ({
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.reserved",
        requestId: request.requestId,
        activationId,
        executionReference: command.payload.executionReference,
        ownerBaseUrl: "http://fixture.invalid",
        workspaceRoot: "/workspace",
        continuity: "warm_reuse",
        continuityId: "fixture-continuity",
      }),
      release,
      refreshServices: async () => {},
      workflowUrlFor: () => "http://fixture.invalid/workflow",
    },
    openAgentSession: async () => handle,
    modelRuntimeLeaseResolver: () => ({
      runtime: {
        kind: "openai_compatible_gateway",
        provider: command.payload.model.provider,
        modelId: command.payload.model.modelId,
        api: "openai-completions",
        baseUrl: fake.baseUrl,
        capability: FAKE_MODEL_API_KEY,
        reasoning: false,
        inputModalities: ["text", "image"],
        hostedTools: [],
        contextWindow: 131072,
        autoCompactTokenLimit: 100000,
        maxTokens: 1024,
        serviceTier: null,
        requestTimeoutMs: 10000,
        // This isolated HTTP model implements the SDK's completions port. Production
        // provider configuration still admits only its pinned Responses routes.
      } as unknown as TrustedModelRuntimeLease["runtime"],
      release: async () => {},
    }),
    waitForToolReply: (request, signals, callId, scope) => {
      const restored = restoreToolReply(
        mailbox.wait(request.operationId, callId!, request.toolName, signals.receipt),
        codec,
        scope!,
        signals.lifetime,
      );
      waits.push(restored);
      const result = restored.result.then((value) => ({
        type: "tool_execution_end" as const,
        ...value,
      }));
      void result.catch(() => {});
      return { result, executionSettled: restored.executionSettled };
    },
  });
  return {
    fake,
    waits,
    storage,
    release,
    commands,
    cancellations,
    fetching,
    finishImage: () => imageGate.resolve(),
    run: () => runner.run(command, async () => {}, stop.signal),
    stop: () =>
      stop.abort({
        kind: "pi-cloud.turn-cancellation",
        reason: "user_request",
        gracePeriodMs: 1000,
      }),
    lateReply: () => {
      for (const c of commands) mailbox.accept(reply(c));
    },
    async close() {
      stop.abort();
      imageGate.resolve();
      mailbox.close();
      await (await runtime)?.close();
      await fake.stop();
      await rm(directory, { recursive: true });
    },
  };
}

it.each(["download_error", "metadata_error", "integrity_error"] as const)(
  "interrupts native execution accurately after a received image reply: %s",
  async (mode) => {
    const unavailable = vi.spyOn(PiSessionWorldStateController.prototype, "recordUnavailable");
    const f = await fixture(mode);
    try {
      await expect(f.run()).rejects.toMatchObject({ code: "tool_result_attachment_unavailable" });
      expect(f.fake.observations).toHaveLength(1);
      expect(f.commands).toHaveLength(1);
      expect(f.waits[0]!.executionSettled()).toBe(true);
      expect(f.cancellations).toEqual([]);
      expect(unavailable).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
        kind: "keep_warm",
      });
      const entries = await f.storage.scanEntries(entriesQuery, 100, undefined, BACKGROUND_CONTEXT);
      const data = JSON.stringify(entries);
      expect(data).toContain("tool_result_attachment_unavailable");
      expect(data).not.toContain("PRIVATE_ATTACHMENT_BACKEND_DETAIL");
      expect(data).not.toContain("tool_operation_outcome_unknown");
    } finally {
      await f.close();
      unavailable.mockRestore();
    }
  },
  20000,
);

it("keeps native Stop authoritative while a received image is still downloading", async () => {
  const unavailable = vi.spyOn(PiSessionWorldStateController.prototype, "recordUnavailable");
  const f = await fixture("stop");
  const running = f.run();
  void running.catch(() => {});
  try {
    await f.fetching.promise;
    expect(f.waits[0]!.executionSettled()).toBe(true);
    f.stop();
    await expect(running).rejects.toMatchObject({ code: "turn_cancelled", reason: "user_request" });
    expect(f.cancellations).toEqual([]);
    expect(unavailable).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledWith(expect.any(String), expect.anything(), {
      kind: "keep_warm",
    });
    const before = JSON.stringify(
      await f.storage.scanEntries(entriesQuery, 100, undefined, BACKGROUND_CONTEXT),
    );
    f.lateReply();
    f.finishImage();
    await Promise.resolve();
    expect(
      JSON.stringify(await f.storage.scanEntries(entriesQuery, 100, undefined, BACKGROUND_CONTEXT)),
    ).toBe(before);
  } finally {
    await f.close();
    unavailable.mockRestore();
  }
}, 20000);

it.each([
  ["stop_after_failure", "turn_cancelled"],
  ["lease_after_failure", "session_lease_revoked"],
  ["writer_after_failure", "writer_publication_failed"],
] as const)(
  "preserves higher-priority native termination after attachment failure: %s",
  async (mode, code) => {
    const f = await fixture(mode);
    try {
      await expect(f.run()).rejects.toMatchObject({ code });
      expect(f.waits[0]!.executionSettled()).toBe(true);
      expect(f.fake.observations).toHaveLength(1);
      expect(f.cancellations).toEqual([]);
    } finally {
      await f.close();
    }
  },
  20000,
);

it("restores the image after its already-satisfied receipt deadline expires", async () => {
  const deadline = new AbortController(),
    originalTimeout = AbortSignal.timeout;
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => (ms === 420000 ? deadline.signal : originalTimeout(ms)));
  const f = await fixture("receipt_deadline");
  const running = f.run();
  void running.catch(() => {});
  try {
    await f.fetching.promise;
    deadline.abort(new DOMException("Receipt wait expired", "TimeoutError"));
    expect(f.waits[0]!.executionSettled()).toBe(true);
    f.finishImage();
    expect((await running).stopReason).toBe("stop");
    expect(f.fake.observations.length).toBeGreaterThanOrEqual(2);
    expect(f.commands).toHaveLength(1);
    const entries = JSON.stringify(
      await f.storage.scanEntries(entriesQuery, 100, undefined, BACKGROUND_CONTEXT),
    );
    expect(entries).toContain(pixels.toString("base64"));
    expect(entries).not.toContain("tool_reply_timeout");
  } finally {
    await f.close();
    timeout.mockRestore();
  }
}, 20000);
