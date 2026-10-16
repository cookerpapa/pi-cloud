import { describe, expect, it } from "vitest";
import type { ConversationDetailResource, PiCloudEvent, ToolProgress } from "@pi-cloud/protocol";
import { SessionEventHub } from "../src/session-event-hub.ts";
import { ToolProgressView } from "../src/tool-progress-view.ts";
import { ToolPreviewBuffer, previewUpdate } from "@pi-cloud/protocol";

const progress: ToolProgress = {
  type: "tool.progress",
  version: 2,
  sessionId: "s",
  turnId: "turn",
  toolCallId: "tool",
  operationId: "op",
  update: { kind: "reset", revision: 1, text: "first" },
};
describe("lossy progress independent from durable ordering", () => {
  it("keeps only newest observations, scopes by tenant/session, and retains no reconnect history", async () => {
    const hub = new SessionEventHub();
    const a = hub.subscribe("a", "s"),
      b = hub.subscribe("b", "s");
    for (let i = 1; i <= 10000; i++)
      hub.publishProgress("a", {
        ...progress,
        update: { kind: "reset", revision: i, text: String(i) },
      });
    expect(await a.next()).toMatchObject({
      progress: { update: { kind: "reset", revision: 10000, text: "10000" } },
    });
    expect(await b.next(1)).toBe("heartbeat");
    a.close();
    hub.publishProgress("a", progress);
    const reconnected = hub.subscribe("a", "s");
    expect(await reconnected.next(1)).toBe("heartbeat");
    hub.resyncAll();
    expect(await reconnected.next()).toEqual({ throughSequence: null });
    hub.onApplicationShutdown();
  });
  it("accepts running snapshot Tools only and rejects duplicates/late output after result or seal", () => {
    const view = new ToolProgressView({
      turns: [
        {
          turnId: "turn",
          state: "running",
          transcript: { items: [{ kind: "tool", status: "running", toolCallId: "tool" }] },
        },
      ],
    } as unknown as ConversationDetailResource);
    expect(view.accept(progress)).toBe(true);
    expect(view.accept(progress)).toBe(false);
    expect(
      view.accept({
        ...progress,
        update: { kind: "reset", revision: 2, text: "wrong" },
        operationId: "wrong",
      }),
    ).toBe(false);
    view.event({
      type: "tool.completed",
      turnId: "turn",
      payload: { toolCallId: "tool" },
    } as PiCloudEvent);
    expect(view.accept({ ...progress, update: { kind: "reset", revision: 2, text: "late" } })).toBe(
      false,
    );
    view.event({
      type: "tool.started",
      turnId: "turn",
      payload: { toolCallId: "tool" },
    } as PiCloudEvent);
    view.event({ type: "turn.failed", turnId: "turn" } as PiCloudEvent);
    expect(view.accept({ ...progress, update: { kind: "reset", revision: 3, text: "late" } })).toBe(
      false,
    );
  });
  it("coalesces slow-reader edits against their sent base and drops unsynchronized suffixes", async () => {
    const hub = new SessionEventHub(),
      sub = hub.subscribe("a", "s"),
      browser = new ToolPreviewBuffer();
    let current = { revision: 1, text: "x".repeat(3000) };
    hub.publishProgress("a", { ...progress, update: { kind: "reset", ...current } });
    browser.accept((await sub.next())!.progress!.update);
    for (let i = 2; i < 30; i++) {
      const next = { revision: i, text: current.text + i };
      hub.publishProgress("a", { ...progress, update: previewUpdate(current, next) });
      current = next;
    }
    const coalesced = (await sub.next())!.progress!.update;
    expect(coalesced.kind).toBe("delta");
    browser.accept(coalesced);
    expect(browser.current).toEqual(current);
    hub.publishProgress("a", {
      ...progress,
      update: {
        kind: "delta",
        baseRevision: 30,
        revision: 31,
        dropHead: 0,
        keepPrefix: 0,
        text: "missing base",
      },
    });
    expect(await sub.next(1)).toBe("heartbeat");
    hub.publishProgress("a", {
      ...progress,
      update: { kind: "reset", revision: 32, text: "recovered" },
    });
    browser.accept((await sub.next())!.progress!.update);
    expect(browser.current?.text).toBe("recovered");
    hub.publish("a", {
      type: "tool.completed",
      sessionId: "s",
      turnId: "turn",
      seq: 1,
      payload: { toolCallId: "tool" },
    } as PiCloudEvent);
    expect((await sub.next())!.event?.type).toBe("tool.completed");
    expect(await sub.next(1)).toBe("heartbeat");
    hub.onApplicationShutdown();
  });
});
