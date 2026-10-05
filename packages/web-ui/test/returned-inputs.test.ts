import { describe, expect, it, vi } from "vitest";
import type { ReturnedInput, ReturnedInputsResource, UserUpload } from "@pi-cloud/protocol";
import { restoreReturnedInputs } from "../src/returned-inputs.ts";

const signal = () => new AbortController().signal;
const item = (n: number): ReturnedInput => ({
  turnId: String(n),
  text: `message ${n}`,
  mailboxPosition: n,
  uploads: [],
});
const page = (items: ReturnedInput[], hasMore = false): ReturnedInputsResource => ({
  sessionId: "session",
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
        .mockResolvedValueOnce(page([item(21)])),
      acknowledgeReturnedInputs: vi.fn(async () => {}),
    };
    let draft = "existing draft";
    const uploads: UserUpload[] = [];
    await expect(
      restoreReturnedInputs(
        api,
        "session",
        new Set(),
        (text, files) => {
          draft += `\n\n${text}`;
          uploads.push(...files);
        },
        signal(),
      ),
    ).resolves.toBe("done");
    expect(draft).toBe(
      ["existing draft", ...Array.from({ length: 21 }, (_, n) => `message ${n + 1}`)].join("\n\n"),
    );
    expect(uploads).toEqual([image]);
    expect(api.acknowledgeReturnedInputs.mock.calls).toHaveLength(2);
  });

  it("does not duplicate restored text when acknowledgement fails or its response is lost", async () => {
    const api = {
      getReturnedInputs: vi.fn(async () => page([item(1)])),
      acknowledgeReturnedInputs: vi
        .fn()
        .mockRejectedValueOnce(new Error("lost"))
        .mockResolvedValueOnce(undefined),
    };
    const restored = new Set<string>(),
      append = vi.fn();
    await expect(restoreReturnedInputs(api, "session", restored, append, signal())).rejects.toThrow(
      "lost",
    );
    await expect(restoreReturnedInputs(api, "session", restored, append, signal())).resolves.toBe(
      "done",
    );
    expect(append).toHaveBeenCalledOnce();
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
    await expect(restoreReturnedInputs(api, "session", new Set(), append, signal())).resolves.toBe(
      "pending",
    );
    expect(append).not.toHaveBeenCalled();
    await expect(
      restoreReturnedInputs(api, "session", new Set(), append, signal()),
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
    const work = restoreReturnedInputs(api, "session", new Set(), append, abort.signal);
    abort.abort();
    resolve(page([item(1)]));
    await expect(work).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
    expect(api.acknowledgeReturnedInputs).not.toHaveBeenCalled();
  });
});
