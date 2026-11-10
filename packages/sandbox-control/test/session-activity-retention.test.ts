import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SessionActivityRetention } from "../src/session-activity-retention.ts";
import type { RuntimeRetention } from "../src/runtime-retention.ts";
import type { SessionActivity } from "@pi-cloud/protocol";
function fact(now = Date.now()): SessionActivity {
  return {
    kind: "session_activity",
    factId: randomUUID(),
    occurredAt: new Date(now).toISOString(),
    scope: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      runId: randomUUID(),
      writerId: randomUUID(),
      piSessionId: randomUUID(),
      fencingToken: 1,
    },
    resources: [{ workspaceId: randomUUID() }],
  };
}
it("reads resource metadata once, renews silent families and never creates a missing VM", async () => {
  const retain = vi.fn(),
    read = vi.fn(async () => ({ id: "allocation", capsule: "opaque" })),
    f = fact();
  const view = new SessionActivityRetention({
    retention: { retain } as unknown as RuntimeRetention,
    read,
  });
  try {
    view.consume(f, () => true);
    await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce());
    view.consume({ ...f, factId: randomUUID() }, () => true);
    expect(read).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(f.scope.tenantId, f.resources[0]);
  } finally {
    await view.close();
  }
  const empty = new SessionActivityRetention({
    retention: { retain } as unknown as RuntimeRetention,
    read: async () => undefined,
  });
  try {
    empty.consume(f, () => true);
    await empty.close();
    expect(retain).toHaveBeenCalledTimes(2);
  } finally {
    await empty.close();
  }
});
it.each(["stale", "revoked", "reset"])(
  "does not renew from %s activity after an asynchronous cold read",
  async (fault) => {
    let now = Date.now(),
      current = true;
    const f = fact(now),
      read = Promise.withResolvers<{ id: string; capsule: string }>(),
      retain = vi.fn();
    const view = new SessionActivityRetention({
      retention: { retain } as unknown as RuntimeRetention,
      read: () => read.promise,
      clock: () => now,
    });
    view.consume(f, () => current);
    if (fault === "stale") now += 46000;
    if (fault === "revoked") current = false;
    if (fault === "reset") view.reset();
    read.resolve({ id: "allocation", capsule: "opaque" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retain).not.toHaveBeenCalled();
    await view.close();
  },
);
