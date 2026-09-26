import { expect, it, vi } from "vitest";
import { ImageAttachmentReaper } from "../src/reaper.ts";
it("aborts an in-flight deletion during shutdown without starting another cleanup", async () => {
  const started = Promise.withResolvers<void>(),
    failed = vi.fn();
  const reap = vi.fn(async (_grace, signal) => {
    started.resolve();
    return new Promise<number>((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
    );
  });
  const reaper = new ImageAttachmentReaper({ reap }, failed, 5);
  await started.promise;
  await reaper.close();
  expect(reap).toHaveBeenCalledTimes(1);
  expect(failed).not.toHaveBeenCalled();
});
