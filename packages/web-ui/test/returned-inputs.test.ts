import { describe, expect, it, vi } from "vitest";
import type { ReturnedInput, ReturnedInputsResource, UserUpload } from "@pi-cloud/protocol";
import { restoreReturnedInputs, inputReturnRecovery } from "../src/returned-inputs.ts";

const signal = () => new AbortController().signal;
const item = (n: number): ReturnedInput => ({
  turnId: String(n),
  idempotencyKey: `input-${n}`,
  text: `message ${n}`,
  mailboxPosition: n,
  uploads: [],
});
const page = (items: ReturnedInput[], hasMore = false): ReturnedInputsResource => ({
  sessionId: "session",
  requestId: "request",
  afterPosition: 0,
  pending: false,
  hasMore,
  items,
});

describe("stopped inputs back to the composer", () => {
  it("restores all pages in order after an existing draft, retaining image attachments", async () => {
    const image = { id: "image" } as UserUpload;
    const first = Array.from({ length: 20 }, (_, n) => item(n + 1));
    first[0]!.uploads = [image];
    const api = {
      getReturnedInputs: vi
        .fn()
        .mockResolvedValueOnce(page(first, true))
        .mockResolvedValueOnce(page([item(21)]))
        .mockResolvedValueOnce({ ...page([]), requestId: null }),
      acknowledgeReturnedInputs: vi.fn(async () => {}),
    };
    let draft = "existing draft";
    const uploads: UserUpload[] = [];
    await expect(
      restoreReturnedInputs(
        api,
        "session",
        inputReturnRecovery(),
        (items) => {
          draft += `\n\n${items.map((input) => input.text).join("\n\n")}`;
          uploads.push(...items.flatMap((input) => input.uploads));
        },
        signal(),
      ),
    ).resolves.toBe("done");
    expect(draft).toBe(
      ["existing draft", ...Array.from({ length: 21 }, (_, n) => `message ${n + 1}`)].join("\n\n"),
    );
    expect(uploads).toEqual([image]);
    expect(api.acknowledgeReturnedInputs.mock.calls).toHaveLength(1);
  });

  it("does not duplicate restored text when acknowledgement fails or its response is lost", async () => {
    const api = {
      getReturnedInputs: vi
        .fn()
        .mockResolvedValueOnce(page([item(1)]))
        .mockResolvedValueOnce(page([]))
        .mockResolvedValueOnce({ ...page([]), requestId: null }),
      acknowledgeReturnedInputs: vi
        .fn()
        .mockRejectedValueOnce(new Error("lost"))
        .mockResolvedValueOnce(undefined),
    };
    const restored = inputReturnRecovery(),
      append = vi.fn();
    await expect(restoreReturnedInputs(api, "session", restored, append, signal())).rejects.toThrow(
      "lost",
    );
    await expect(restoreReturnedInputs(api, "session", restored, append, signal())).resolves.toBe(
      "done",
    );
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith([item(1)]);
  });

  it("waits for Steer consumption, and retains the server copy if restoration fails", async () => {
    const api = {
      getReturnedInputs: vi
        .fn()
        .mockResolvedValueOnce({ ...page([]), pending: true })
        .mockResolvedValueOnce(page([item(1)])),
      acknowledgeReturnedInputs: vi.fn(),
    };
    const append = vi.fn(() => false);
    await expect(
      restoreReturnedInputs(api, "session", inputReturnRecovery(), append, signal()),
    ).resolves.toBe("pending");
    expect(append).not.toHaveBeenCalled();
    await expect(
      restoreReturnedInputs(api, "session", inputReturnRecovery(), append, signal()),
    ).rejects.toThrow();
    expect(api.acknowledgeReturnedInputs).not.toHaveBeenCalled();
  });

  it("never transfers a delayed page into a different conversation", async () => {
    const abort = new AbortController();
    let resolve!: (page: ReturnedInputsResource) => void;
    const waiting = new Promise<ReturnedInputsResource>((done) => {
      resolve = done;
    });
    const api = {
      getReturnedInputs: vi.fn(() => waiting),
      acknowledgeReturnedInputs: vi.fn(),
    };
    const append = vi.fn();
    const work = restoreReturnedInputs(api, "session", inputReturnRecovery(), append, abort.signal);
    abort.abort();
    resolve(page([item(1)]));
    await expect(work).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(api.acknowledgeReturnedInputs).not.toHaveBeenCalled();
  });
});
