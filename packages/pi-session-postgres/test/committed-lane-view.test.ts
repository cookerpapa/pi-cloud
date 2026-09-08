import type { Entry } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { CommittedLaneView } from "../src/committed-lane-view.ts";
import type { PiSessionMutationOperation } from "../src/session-mutation.ts";

function entry(id: string, parentId: string | null = null, seq = 1): Entry {
  return {
    id,
    parentId,
    seq,
    timestamp: 1,
    type: "custom",
    customType: "test",
    data: { text: id },
  };
}

function append(value: Entry, lane = "main"): PiSessionMutationOperation {
  return { kind: "append_entry", lane, entry: value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("CommittedLaneView", () => {
  it("loads once and observes only successful projection receipts", async () => {
    const readBranch = vi.fn(async () => [entry("a")]);
    const view = new CommittedLaneView({ lane: "main", readBranch });
    await view.read();
    const commit = deferred<unknown>();
    const publisher = view.publisher({ mutate: () => commit.promise });
    const b = entry("b", "a", 9); // global Session seq includes other Lanes and Records
    const pending = publisher.mutate(append(b));
    expect(await view.read()).toEqual([entry("a")]);
    commit.resolve(b);
    await pending;
    expect(await view.read()).toEqual([entry("a"), b]);
    expect(readBranch).toHaveBeenCalledTimes(1);
    expect(view.statistics()).toMatchObject({ storageReads: 1, memoryReads: 2, updates: 1 });
  });

  it("never inserts a rejected write or regresses on duplicate receipts", async () => {
    const a = entry("a");
    const view = new CommittedLaneView({ lane: "main", readBranch: async () => [a] });
    await view.read();
    const publisher = view.publisher({
      mutate: async () => {
        throw new Error("projection rejected");
      },
    });
    await expect(publisher.mutate(append(entry("b", "a")))).rejects.toThrow("projection rejected");
    const b = entry("b", "a", 2);
    view.committed(append(b), b);
    view.committed(append(a), a);
    expect(await view.read()).toEqual([a, b]);
  });

  it("applies atomic mixed batches without importing other Lanes", async () => {
    const a = entry("a");
    const view = new CommittedLaneView({ lane: "main", readBranch: async () => [a] });
    await view.read();
    const b = entry("b", "a", 4);
    const other = entry("other", "a", 2);
    const record = {
      id: "record",
      type: "abort_requested" as const,
      lane: "main",
      runId: "operation",
    };
    view.committed(
      {
        kind: "append_items",
        items: [
          { kind: "append_entry", lane: "child", entry: other },
          { kind: "append_record", record },
          { kind: "append_entry", lane: "main", entry: b },
        ],
      },
      { items: [other, { ...record, seq: 3, timestamp: 1 }, b] },
    );
    view.committed({ kind: "set_name", name: "new name" }, undefined);
    view.committed({ kind: "move_lane", lane: "child", to: null }, undefined);
    expect(await view.read()).toEqual([a, b]);
    expect(view.statistics().storageReads).toBe(1);
  });

  it("replaces the active path with native Compaction and its retained tail", async () => {
    const view = new CommittedLaneView({ lane: "main", readBranch: async () => [entry("a")] });
    await view.read();
    const compact: Entry = {
      id: "c",
      parentId: "a",
      seq: 2,
      timestamp: 1,
      type: "compaction",
      summary: "summary",
      tokensBefore: 1000,
      retainedTail: [{ role: "user", content: "retained", timestamp: 1 }],
    };
    const b = entry("b", "c", 3);
    view.committed(
      {
        kind: "append_items",
        items: [
          { kind: "append_entry", lane: "main", entry: compact },
          { kind: "append_entry", lane: "main", entry: b },
        ],
      },
      { items: [compact, b] },
    );
    expect(await view.read()).toEqual([compact, b]);
    expect(view.statistics()).toMatchObject({ storageReads: 1, retainedEntries: 2 });
  });

  it.each(["move", "parent conflict", "incomplete receipt"])("reloads after %s", async (reason) => {
    let branch = [entry("a")];
    const readBranch = vi.fn(async () => branch);
    const view = new CommittedLaneView({ lane: "main", readBranch });
    await view.read();
    branch = [entry("replacement")];
    if (reason === "move")
      view.committed({ kind: "move_lane", lane: "main", to: "replacement" }, undefined);
    else if (reason === "parent conflict") view.committed(append(branch[0]!), branch[0]);
    else
      view.committed(
        {
          kind: "append_items",
          items: [{ kind: "append_entry", lane: "main", entry: branch[0]! }],
        },
        { items: [] },
      );
    expect(await view.read()).toEqual(branch);
    expect(readBranch).toHaveBeenCalledTimes(2);
  });

  it("singleflights cold readers but reloads a read racing a commit", async () => {
    const stale = deferred<Entry[]>();
    const a = entry("a");
    const b = entry("b", "a", 2);
    const readBranch = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue([a, b]);
    const view = new CommittedLaneView({ lane: "main", readBranch });
    const readers = [view.read(), view.read()];
    view.committed(append(b), b);
    stale.resolve([a]);
    expect(await Promise.all(readers)).toEqual([
      [a, b],
      [a, b],
    ]);
    expect(readBranch).toHaveBeenCalledTimes(2);
  });

  it("does not retain mutable model context, receipt or storage references", async () => {
    const a = entry("a");
    const view = new CommittedLaneView({ lane: "main", readBranch: async () => [a] });
    const snapshot = await view.read();
    (a as { data: unknown }).data = "storage mutated";
    const b = entry("b", "a", 2);
    view.committed(append(b), b);
    (b as { data: unknown }).data = "receipt mutated";
    snapshot[0]!.id = "caller mutated";
    expect(await view.read()).toEqual([entry("a"), entry("b", "a", 2)]);
  });

  it("drops memory at Run end and cannot resurrect after close", async () => {
    const pending = deferred<Entry[]>();
    const view = new CommittedLaneView({ lane: "main", readBranch: () => pending.promise });
    const read = view.read();
    view.close();
    pending.resolve([entry("a")]);
    await expect(read).rejects.toThrow("closed");
    await expect(view.read()).rejects.toThrow("closed");
    view.committed(append(entry("b")), entry("b"));
    expect(view.statistics().retainedEntries).toBe(0);
  });

  it("retries storage after a failed cold read", async () => {
    const readBranch = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage offline"))
      .mockResolvedValue([entry("a")]);
    const view = new CommittedLaneView({ lane: "main", readBranch });
    await expect(view.read()).rejects.toThrow("storage offline");
    expect(await view.read()).toEqual([entry("a")]);
  });
});
