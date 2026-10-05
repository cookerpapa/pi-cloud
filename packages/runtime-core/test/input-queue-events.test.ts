import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { InputQueueResource } from "@pi-cloud/protocol";
import { SessionEventHub } from "../src/session-event-hub.ts";

it("coalesces queue snapshots per subscriber, isolates tenants and clears on resync", async () => {
  const hub = new SessionEventHub(),
    tenant = randomUUID(),
    session = randomUUID();
  const subscription = hub.subscribe(tenant, session),
    foreign = hub.subscribe(randomUUID(), session);
  const value = (version: string): InputQueueResource => ({
    sessionId: session,
    revision: 1,
    viewVersion: version,
    afterPosition: 0,
    hasMore: false,
    activeTurnId: null,
    hasReturnedInputs: false,
    items: [],
  });
  expect(hub.hasSubscribers(tenant, session)).toBe(true);
  hub.publishInputQueue(tenant, value("1"));
  hub.publishInputQueue(tenant, value("3"));
  hub.publishInputQueue(tenant, value("2"));
  expect(await subscription.next()).toEqual({ throughSequence: null, inputQueue: value("3") });
  foreign.close();
  expect(await foreign.next()).toBeUndefined();
  hub.publishInputQueue(tenant, value("4"));
  hub.resyncSession(tenant, session);
  expect(await subscription.next()).toEqual({ throughSequence: null });
  subscription.close();
  expect(await subscription.next()).toBeUndefined();
  expect(hub.hasSubscribers(tenant, session)).toBe(false);
});
