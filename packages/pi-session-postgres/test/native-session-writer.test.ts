import { InMemorySessionStorage, type Entry } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { NativeSessionWriter } from "../src/native-session-writer.ts";
import { committedItemSequence, type PiCommittedItem } from "../src/session-mutation.ts";

const metadata = { id: "native-session", createdAt: 1 };
const value = (id: string) => ({
  id,
  type: "custom" as const,
  customType: "state",
  data: { text: id },
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(
  branch: Entry[] = [],
  nextSequence = 1,
  reader = new InMemorySessionStorage(metadata),
) {
  const waitProjected = vi.fn<() => Promise<void>>(async () => {
    throw new Error("projection intentionally stopped");
  });
  const fail = vi.fn(async () => {});
  const published: PiCommittedItem[][] = [];
  const publisher = {
    publish: vi.fn(async (items: readonly PiCommittedItem[]) => {
      published.push(structuredClone([...items]));
    }),
  };
  const hasId = vi.fn(async () => false);
  const writer = new NativeSessionWriter({
    id: "writer-1",
    metadata,
    nextSequence,
    lanes: [{ lane: "main", leafId: branch.at(-1)?.id ?? null }],
    hasId,
    waitProjected,
    fail,
  });
  const main = await writer.open(
    { lane: "main", turnId: "turn-1", attemptId: "attempt-1" },
    { branch, openOperations: [], reader },
    publisher,
  );
  return { writer, main, reader, waitProjected, hasId, fail, published, publisher };
}

describe("Kafka-acknowledged native Session writer", () => {
  it("matches upstream branch-query semantics across order, bounds, filters and cursors", async () => {
    const reader = new InMemorySessionStorage(metadata);
    const entries: Entry[] = [];
    for (let i = 0; i < 6; i++) {
      entries.push(
        await reader.appendEntry(
          i === 2 || i === 4
            ? {
                id: `e${i}`,
                type: "compaction",
                summary: "state",
                retainedTail: [],
                tokensBefore: 10,
              }
            : { ...value(`e${i}`), customType: i === 3 ? "other" : "state" },
          "main",
        ),
      );
    }
    const f = await fixture(entries.slice(4), 7, reader);
    f.waitProjected.mockResolvedValue(undefined);
    for (const start of entries.map((entry) => entry.id))
      for (const order of [undefined, "newestFirst", "oldestFirst"] as const)
        for (const customType of [undefined, "state", "other", ""])
          for (const cursor of [undefined, { afterSeq: 3 }])
            for (const stopAtType of [undefined, "compaction", "custom"] as const)
              for (const limit of [undefined, 1, 2]) {
                const query = {
                  start,
                  ...(order ? { order } : {}),
                  ...(customType === undefined ? {} : { customType }),
                  ...(cursor ? { cursor } : {}),
                  ...(stopAtType ? { stopAtType } : {}),
                  ...(limit ? { limit } : {}),
                };
                expect(await f.main.findEntriesOnBranch(query), JSON.stringify(query)).toEqual(
                  await reader.findEntriesOnBranch(query),
                );
              }
  });
  it("does not return a newer custom state for a historical branch anchor", async () => {
    const reader = new InMemorySessionStorage(metadata);
    const before = await reader.appendEntry(value("before"), "main");
    const summary = await reader.appendEntry(
      {
        id: "summary",
        type: "compaction",
        summary: "state",
        retainedTail: [],
        tokensBefore: 100,
      },
      "main",
    );
    const f = await fixture([summary], summary.seq + 1, reader);
    const later = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(
      await f.main.findEntriesOnBranch({ start: later.id, customType: "state", limit: 1 }),
    ).toEqual([later]);
    expect(f.waitProjected).not.toHaveBeenCalled();
    f.waitProjected.mockResolvedValue(undefined);
    expect(
      await f.main.findEntriesOnBranch({ start: summary.id, customType: "state", limit: 1 }),
    ).toEqual([before]);
  });

  it("keeps custom-state fallback on the moved branch, not the original Run base", async () => {
    const reader = new InMemorySessionStorage(metadata);
    const before = await reader.appendEntry(value("before"), "main");
    const summary = await reader.appendEntry(
      {
        id: "summary",
        type: "compaction",
        summary: "state",
        retainedTail: [],
        tokensBefore: 100,
      },
      "main",
    );
    const f = await fixture([summary], summary.seq + 1, reader);
    const later = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    await reader.appendEntry(value(later.id), "main");
    await f.main.appendRecord({
      id: f.writer.idGenerator(),
      lane: "main",
      type: "operation_started",
      sourceLeafId: later.id,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await f.main.moveLane("main", summary.id);
    f.waitProjected.mockResolvedValue(undefined);
    expect(
      await f.main.findEntriesOnBranch({ start: summary.id, customType: "state", limit: 1 }),
    ).toEqual([before]);
  });
  it("matches native newest-first cursors within the active context", async () => {
    const f = await fixture();
    const entries: Entry[] = [];
    for (let i = 0; i < 3; i++)
      entries.push(await f.main.appendEntry(value(f.writer.idGenerator()), "main"));
    expect(
      await f.main.findEntriesOnBranch({
        start: entries[2]!.id,
        stopAtType: "compaction",
        order: "newestFirst",
        cursor: { afterSeq: entries[1]!.seq },
      }),
    ).toEqual([entries[0]]);
    expect(f.waitProjected).not.toHaveBeenCalled();
  });

  it("uses native oldest-first bounds rather than reversing the latest Compaction suffix", async () => {
    const reader = new InMemorySessionStorage(metadata);
    await reader.appendEntry(value("oldest"), "main");
    const summary = await reader.appendEntry(
      { id: "summary", type: "compaction", summary: "state", retainedTail: [], tokensBefore: 10 },
      "main",
    );
    const tail = await reader.appendEntry(value("latest"), "main");
    const f = await fixture([summary, tail], tail.seq + 1, reader);
    f.waitProjected.mockResolvedValue(undefined);
    const query = {
      start: tail.id,
      stopAtType: "compaction" as const,
      order: "oldestFirst" as const,
    };
    expect(await f.main.findEntriesOnBranch(query)).toEqual(
      await reader.findEntriesOnBranch(query),
    );
    const oldestCustom = {
      start: tail.id,
      customType: "state",
      limit: 1,
      order: "oldestFirst" as const,
    };
    expect(await f.main.findEntriesOnBranch(oldestCustom)).toEqual(
      await reader.findEntriesOnBranch(oldestCustom),
    );
  });
  it("restores only a compaction suffix while preserving original stamps and parent", async () => {
    const branch: Entry[] = [
      {
        id: "summary",
        seq: 700,
        timestamp: 14,
        parentId: "not-downloaded",
        type: "compaction",
        summary: "bounded",
        retainedTail: [],
        tokensBefore: 900000,
      },
      { ...value("suffix"), seq: 710, timestamp: 15, parentId: "summary" },
    ];
    const f = await fixture(branch, 730);
    const written = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(written).toMatchObject({ seq: 730, parentId: "suffix" });
    const path = await f.main.findEntriesOnBranch({
      start: written.id,
      stopAtType: "compaction",
      order: "newestFirst",
    });
    expect(path.reverse()).toEqual([...branch, written]);
    if (written.type !== "custom") throw new Error("custom fixture");
    written.data = "mutated by caller";
    expect(await f.main.getEntry(written.id)).toMatchObject({ data: { text: written.id } });
    expect(f.hasId).not.toHaveBeenCalled();
    expect(f.waitProjected).not.toHaveBeenCalled();
  });

  it("does not expose speculative data, and owns inputs before queueing", async () => {
    const f = await fixture();
    const entered = deferred(),
      ack = deferred();
    f.publisher.publish.mockImplementationOnce(async (items) => {
      f.published.push(structuredClone([...items]));
      entered.resolve();
      await ack.promise;
    });
    const input = value(f.writer.idGenerator());
    const pending = f.main.appendEntry(input, "main");
    input.data.text = "caller changed input";
    await entered.promise;
    let readReturned = false;
    const read = f.main.getLanes().then((lanes) => {
      readReturned = true;
      return lanes;
    });
    await Promise.resolve();
    expect(readReturned).toBe(false);
    ack.resolve();
    const entry = await pending;
    expect(entry).toMatchObject({ data: { text: input.id } });
    expect(await read).toEqual([{ lane: "main", leafId: input.id }]);
  });

  it("creates inherited and empty child Lanes from acknowledged memory with projection stopped", async () => {
    const f = await fixture();
    const before = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    const operationId = f.writer.idGenerator();
    await f.main.appendRecord({
      id: operationId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: before.id,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    const prompt = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(f.main.baseContext()).toEqual([before]);
    await f.main.createLane("inherited", before.id);
    await f.main.createLane("empty", null);
    const inherited = await f.writer.open(
      { lane: "inherited", turnId: "child-turn", attemptId: "child-attempt" },
      { branch: [], openOperations: [], reader: f.reader },
      f.publisher,
    );
    const empty = await f.writer.open(
      { lane: "empty", turnId: "fresh-turn", attemptId: "fresh-attempt" },
      { branch: [], openOperations: [], reader: f.reader },
      f.publisher,
    );
    const entries = await Promise.all([
      inherited.appendEntry(value(f.writer.idGenerator()), "inherited"),
      empty.appendEntry(value(f.writer.idGenerator()), "empty"),
      f.main.appendEntry(value(f.writer.idGenerator()), "main"),
    ]);
    expect(entries.map((e) => e.parentId)).toEqual([before.id, null, prompt.id]);
    expect(f.published.flat().map(committedItemSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(
      (
        await inherited.findEntriesOnBranch({
          start: entries[0]!.id,
          stopAtType: "compaction",
          order: "newestFirst",
        })
      )
        .reverse()
        .map((e) => e.id),
    ).toEqual([before.id, entries[0]!.id]);
    expect(f.waitProjected).not.toHaveBeenCalled();
  });

  it("serializes concurrent Child creation without publishing the same Lane twice", async () => {
    const f = await fixture();
    const result = await Promise.allSettled([
      f.main.createLane("child", null),
      f.main.createLane("child", null),
    ]);
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(f.published.flat()).toHaveLength(1);
    expect(f.writer.failed).toBe(false);
    const next = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(next.seq).toBe(2);
  });

  it("rolls back a locally invalid batch before publish without poisoning the writer", async () => {
    const f = await fixture();
    const entry = value(f.writer.idGenerator());
    await expect(
      f.main.mutate({
        kind: "append_items",
        items: [
          { kind: "append_entry", lane: "main", entry },
          { kind: "append_entry", lane: "main", entry },
        ],
      }),
    ).rejects.toThrow();
    expect(f.published).toHaveLength(0);
    expect(f.writer.failed).toBe(false);
    expect(await f.main.appendEntry(entry, "main")).toMatchObject({ seq: 1, parentId: null });
  });

  it("stops every Lane after uncertain publication without recycling sequence numbers", async () => {
    const f = await fixture();
    await f.main.createLane("child", null);
    const child = await f.writer.open(
      { lane: "child", turnId: "child", attemptId: "child" },
      { branch: [], openOperations: [], reader: f.reader },
      f.publisher,
    );
    f.publisher.publish.mockImplementationOnce(async (items) => {
      f.published.push(structuredClone([...items]));
      throw new Error("Kafka ACK lost");
    });
    await expect(f.main.appendEntry(value(f.writer.idGenerator()), "main")).rejects.toThrow(
      "Kafka ACK lost",
    );
    expect(child.signal.aborted).toBe(true);
    await expect(child.appendEntry(value(f.writer.idGenerator()), "child")).rejects.toThrow(
      "requires recovery",
    );
    expect(f.published.flat().map(committedItemSequence)).toEqual([1, 2]);
    expect(f.fail).toHaveBeenCalledOnce();
  });

  it("replaces the active branch on compaction and supports Lane movement", async () => {
    const f = await fixture();
    const old = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    const summary = await f.main.appendEntry(
      {
        id: f.writer.idGenerator(),
        type: "compaction",
        summary: "new state",
        retainedTail: [],
        tokensBefore: 42,
      },
      "main",
    );
    const next = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(
      (
        await f.main.findEntriesOnBranch({
          start: next.id,
          stopAtType: "compaction",
          order: "newestFirst",
        })
      )
        .reverse()
        .map((e) => e.id),
    ).toEqual([summary.id, next.id]);
    expect(summary.parentId).toBe(old.id);
    await f.main.moveLane("main", summary.id);
    const replaced = await f.main.appendEntry(value(f.writer.idGenerator()), "main");
    expect(replaced.parentId).toBe(summary.id);
    expect(
      (
        await f.main.findEntriesOnBranch({
          start: replaced.id,
          stopAtType: "compaction",
          order: "newestFirst",
        })
      )
        .reverse()
        .map((e) => e.id),
    ).toEqual([summary.id, replaced.id]);
    f.main.close();
    expect(f.writer.activeLanes).toBe(0);
    await expect(f.main.getLanes()).rejects.toThrow("closed");
  });
});
