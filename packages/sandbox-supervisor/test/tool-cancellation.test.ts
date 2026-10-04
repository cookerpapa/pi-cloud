import { describe, expect, it, vi } from "vitest";
import { awaitCancelledToolReply } from "../src/tool-cancellation.ts";

function fixture() {
  const signal = new AbortController(),
    reply = Promise.withResolvers<string>();
  const cancel = vi.fn(async () => {}),
    unconfirmed = vi.fn();
  const options = {
    signal: signal.signal,
    reply: reply.promise,
    received: () => false,
    cancel,
    unconfirmed,
    abortWait: reply.reject,
    timeoutMs: 20,
  };
  return { signal, reply, cancel, unconfirmed, options };
}
describe("remote Tool cancellation settlement", () => {
  it("keeps waiting after cancel acceptance and returns the original Tool result", async () => {
    const f = fixture();
    let ended = false;
    const result = awaitCancelledToolReply({ ...f.options, timeoutMs: 1000 }).finally(() => {
      ended = true;
    });
    f.signal.abort();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    expect(ended).toBe(false);
    f.reply.resolve("partial output\nCommand aborted");
    expect(await result).toBe("partial output\nCommand aborted");
    expect(f.unconfirmed).not.toHaveBeenCalled();
  });
  it("preserves a final reply despite a lost cancellation publication ACK", async () => {
    const f = fixture();
    f.cancel.mockRejectedValue(new Error("ACK lost"));
    const result = awaitCancelledToolReply({ ...f.options, timeoutMs: 1000 });
    f.signal.abort();
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledOnce());
    f.reply.resolve("already completed");
    expect(await result).toBe("already completed");
    expect(f.unconfirmed).not.toHaveBeenCalled();
  });
  it("bounds missing replies as UNKNOWN without fabricating a stopped process", async () => {
    const f = fixture();
    const result = awaitCancelledToolReply(f.options);
    f.signal.abort();
    await expect(result).rejects.toThrow("tool_operation_outcome_unknown");
    expect(f.unconfirmed).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it("does not send cancellation after the final result has already arrived", async () => {
    const f = fixture();
    f.reply.resolve("complete");
    f.signal.abort();
    expect(await awaitCancelledToolReply({ ...f.options, received: () => true })).toBe("complete");
    expect(f.cancel).not.toHaveBeenCalled();
  });
});
