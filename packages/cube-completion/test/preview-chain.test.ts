import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  previewUpdate,
  boundedPreviewText,
  type ToolPreviewState,
  type ToolPreviewUpdate,
  type ToolProgressDelivery,
} from "@pi-cloud/protocol";
import { ToolProgressPublisher } from "@pi-cloud/event-log";
import { CubeCompletionAdapter, type CompletionPacket } from "../src/adapter.ts";
import { ToolProgressIngress } from "../../control-plane/src/tool-progress-ingress.ts";
import { SessionEventHub } from "../../runtime-core/src/session-event-hub.ts";
import { ToolProgressStore } from "../../web-ui/src/tool-progress.tsx";

it("transfers bounded edits through actual HTTP and SSE coalescing, recovering loss and owner changes", async () => {
  const hub = new SessionEventHub(),
    server = Fastify();
  const requests: ToolProgressDelivery[] = [];
  let rejectNext: "failure" | "redirect" | undefined,
    url = "";
  server.addHook("preHandler", async (request, reply) => {
    requests.push(request.body as ToolProgressDelivery);
    const mode = rejectNext;
    rejectNext = undefined;
    if (mode === "failure") return reply.code(503).send();
    if (mode === "redirect")
      return reply
        .code(307)
        .header("location", url + "/internal/v1/tool-progress")
        .send();
  });
  new ToolProgressIngress(
    "preview-test",
    async () => undefined,
    ({ tenantId, progress }) => hub.publishProgress(tenantId, progress),
  ).install(server);
  await server.listen({ host: "127.0.0.1", port: 0 });
  url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const sender = new ToolProgressPublisher(url, "preview-test");
  const publish = vi.fn(async () => {});
  const adapter = new CubeCompletionAdapter({ progress: sender, publish });
  const scope = {
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    piSessionId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    writerId: randomUUID(),
    fencingToken: 1,
  };
  const operationId = randomUUID(),
    toolCallId = "task:123",
    nativeCallId = "provider-call";
  const packet: CompletionPacket = {
    kind: "progress",
    operationId,
    context: {
      scope,
      replyTopic: "unused-preview-reply-topic",
      toolCallId,
      nativeToolCallId: nativeCallId,
      toolName: "bash",
      partition: 0,
    },
  };
  let subscription = hub.subscribe(scope.tenantId, scope.sessionId);
  const browser = new ToolProgressStore();
  const key = `${scope.turnId}\0${toolCallId}`;
  const unsubscribe = browser.subscribe(key, () => {});
  let source: ToolPreviewState = { revision: 1, text: "original line\n".repeat(400) };
  const deliver = (update: ToolPreviewUpdate) =>
    adapter.accept({
      ...packet,
      output: {
        type: "worker.preview",
        operationId,
        toolCallId: nativeCallId,
        toolName: "bash",
        update,
      },
    });
  const change = (suffix: string, reset = false) => {
    const next = { revision: source.revision + 1, text: boundedPreviewText(source.text + suffix) };
    const update = previewUpdate(source, next, reset);
    source = next;
    return update;
  };
  const receive = async () => {
    const wake = await subscription.next(4000);
    expect(wake).not.toBe("heartbeat");
    if (!wake || wake === "heartbeat" || !wake.progress) throw new Error("Missing preview");
    browser.receive(wake.progress);
    expect(browser.get(key)).toEqual(source);
    return wake.progress.update;
  };
  try {
    await deliver({ kind: "reset", ...source });
    await receive();
    const resetBytes = Buffer.byteLength(JSON.stringify(requests[0]));
    const edits = Array.from({ length: 20 }, (_, i) => change(`next ${i}\n`));
    await Promise.all(edits.map(deliver));
    expect((await receive()).kind).toBe("delta");
    const editBytes = Buffer.byteLength(JSON.stringify(requests[1]));
    expect(editBytes).toBeLessThan(resetBytes / 2);
    expect(requests).toHaveLength(2);

    change("dropped before Cubelet\n");
    await deliver(change("cannot apply without its base\n"));
    expect(await subscription.next(1200)).toBe("heartbeat");
    await deliver(change("", true));
    expect((await receive()).kind).toBe("reset");

    for (const mode of ["failure", "redirect"] as const) {
      const count = requests.length;
      rejectNext = mode;
      await deliver(change("lost HTTP observation\n"));
      await vi.waitFor(() => expect(requests).toHaveLength(count + 1), { timeout: 3000 });
      await deliver(change("next observation\n"));
      expect((await receive()).kind).toBe("reset");
    }

    subscription.close();
    browser.reset();
    subscription = hub.subscribe(scope.tenantId, scope.sessionId);
    await deliver(change("new subscriber needs a base\n"));
    expect(await subscription.next(1200)).toBe("heartbeat");
    // The source's quiet-period keyframe restores a newly opened browser too.
    await deliver(change("", true));
    expect((await receive()).kind).toBe("reset");
    const count = requests.length;
    await deliver({ kind: "reset", ...source });
    expect(await subscription.next(1200)).toBe("heartbeat");
    expect(requests).toHaveLength(count);
    expect(publish).not.toHaveBeenCalled();
    expect(JSON.stringify(requests)).not.toContain("partialResult");
    expect(JSON.stringify(requests)).not.toContain("args");
    process.stdout.write(
      JSON.stringify({
        check: "tool-preview-http-bytes",
        resetBytes,
        coalescedEditBytes: editBytes,
      }) + "\n",
    );
  } finally {
    unsubscribe();
    subscription.close();
    await sender.close();
    await server.close();
    hub.onApplicationShutdown();
  }
}, 30000);
