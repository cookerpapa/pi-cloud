import { describe, expect, it } from "vitest";
import type { ConversationDetailResource, PiCloudEvent, ToolProgress } from "@pi-cloud/protocol";
import { SessionEventHub } from "../src/session-event-hub.ts";
import { ToolProgressView } from "../src/tool-progress-view.ts";

const progress: ToolProgress = {
  type: "tool.progress",
  sessionId: "s",
  turnId: "turn",
  toolCallId: "tool",
  operationId: "op",
  revision: 1,
  text: "first",
};
describe("lossy progress independent from durable ordering", () => {
  it("keeps only newest observations, scopes by tenant/session, and retains no reconnect history", async () => {
    const hub = new SessionEventHub();
    const a = hub.subscribe("a", "s"),
      b = hub.subscribe("b", "s");
    for (let i = 1; i <= 10000; i++)
      hub.publishProgress("a", { ...progress, revision: i, text: String(i) });
    expect(await a.next()).toMatchObject({ progress: { revision: 10000, text: "10000" } });
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
    expect(view.accept({ ...progress, revision: 2, operationId: "wrong" })).toBe(false);
    view.event({
      type: "tool.completed",
      turnId: "turn",
      payload: { toolCallId: "tool" },
    } as PiCloudEvent);
    expect(view.accept({ ...progress, revision: 2 })).toBe(false);
    view.event({
      type: "tool.started",
      turnId: "turn",
      payload: { toolCallId: "tool" },
    } as PiCloudEvent);
    view.event({ type: "turn.failed", turnId: "turn" } as PiCloudEvent);
    expect(view.accept({ ...progress, revision: 3 })).toBe(false);
  });
});
