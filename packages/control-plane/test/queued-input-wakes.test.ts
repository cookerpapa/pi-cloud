import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { InputQueueView } from "../src/input-queue-view.ts";
import type { InputQueueResource } from "@pi-cloud/protocol";

it("coalesces native commit wakes without comparing them to PG control versions", async () => {
  const tenant = randomUUID(),
    session = randomUUID();
  const value: InputQueueResource = {
    sessionId: session,
    revision: `${"a".repeat(64)}.${"b".repeat(64)}`,
    viewVersion: ((50n << 64n) + 3n).toString(),
    activeTurnId: null,
    hasReturnedInputs: false,
    afterPosition: 0,
    hasMore: false,
    items: [],
  };
  const pending = Promise.withResolvers<InputQueueResource>();
  const read = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(value),
    publish = vi.fn();
  const view = new InputQueueView({
    read,
    publish,
    unavailable: () => {},
    watched: () => true,
    onError: () => {},
  });
  view.notify(tenant, session, () => true);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  for (let n = 0; n < 100; n++) view.notify(tenant, session, () => true);
  pending.resolve(value);
  await view.settle();
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledOnce();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(read).toHaveBeenCalledTimes(2);
  view.notify(tenant, session, () => true);
  await view.settle();
  expect(read).toHaveBeenCalledTimes(3);
  await view.close();
});
