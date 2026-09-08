import { describe, expect, it } from "vitest";
import { KafkaAckSessionStorage, type NativeAppend, type NativeFact } from "./storage.ts";

const metadata = () => ({ id: crypto.randomUUID(), createdAt: Date.now() });
const message = (id: string) => ({
  id,
  type: "message" as const,
  message: { role: "user" as const, content: id, timestamp: 1 },
});

describe("Kafka ACK SessionStorage experiment", () => {
  it("does not release append or reads before a durable ACK", async () => {
    let acknowledge!: () => void, published!: () => void;
    const arrived = new Promise<void>((resolve) => {
      published = resolve;
    });
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const storage = new KafkaAckSessionStorage(metadata(), "writer", async () => {
      published();
      await ack;
    });
    let appendDone = false,
      readDone = false;
    const append = storage.appendEntry(message("a"), "main").then(() => {
      appendDone = true;
    });
    await arrived;
    const read = storage.getEntry("a").then((value) => {
      readDone = true;
      return value;
    });
    await Promise.resolve();
    expect(appendDone).toBe(false);
    expect(readDone).toBe(false);
    acknowledge();
    await append;
    expect(await read).toMatchObject({ id: "a", seq: 1, parentId: null });
  });

  it("coordinates multiple Lanes with one sequence without a PG dependency", async () => {
    const facts: NativeFact[] = [];
    const storage = new KafkaAckSessionStorage(metadata(), "writer", async (fact) => {
      facts.push(fact);
    });
    await storage.appendEntry(message("root"), "main");
    await storage.createLane("child", "root");
    await storage.createLane("fresh", null);
    await Promise.all([
      storage.appendEntry(message("parent"), "main"),
      storage.appendEntry(message("child"), "child"),
      storage.appendEntry(message("fresh"), "fresh"),
    ]);
    expect((await storage.getLog()).map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await storage.getEntry("parent")).toMatchObject({ parentId: "root" });
    expect(await storage.getEntry("child")).toMatchObject({ parentId: "root" });
    expect(await storage.getEntry("fresh")).toMatchObject({ parentId: null });
    expect(facts).toHaveLength(6);
  });

  it("poisons an uncertain writer rather than reusing its sequence", async () => {
    const facts: NativeFact[] = [];
    const storage = new KafkaAckSessionStorage(metadata(), "writer", async (fact) => {
      facts.push(fact); // Kafka may have persisted it, but the caller lost the ACK.
      throw new Error("ACK lost");
    });
    await expect(storage.appendEntry(message("a"), "main")).rejects.toThrow("ACK lost");
    await expect(storage.appendEntry(message("b"), "main")).rejects.toThrow("requires recovery");
    await expect(storage.getEntry("a")).rejects.toThrow("requires recovery");
    expect(facts).toHaveLength(1);
  });

  it("keeps validation failures that did not mutate recoverable", async () => {
    const storage = new KafkaAckSessionStorage(metadata(), "writer", async () => {});
    await expect(storage.appendEntry(message("a"), "missing")).rejects.toThrow();
    expect(await storage.appendEntry(message("b"), "main")).toMatchObject({ seq: 1 });
  });

  it("publishes a complete batch once and rejects appends after its seal", async () => {
    const facts: NativeFact[] = [];
    const storage = new KafkaAckSessionStorage(metadata(), "writer", async (f) => {
      facts.push(f);
    });
    const result = await storage.appendItems([
      { kind: "append_entry", lane: "main", entry: message("a") },
      { kind: "append_entry", lane: "main", entry: message("b") },
    ]);
    expect(result.items.map((i) => i.seq)).toEqual([1, 2]);
    expect(facts).toHaveLength(1);
    await storage.seal();
    expect(facts[1]).toMatchObject({ kind: "seal", through: 2 });
    await expect(storage.appendEntry(message("c"), "main")).rejects.toThrow("sealed");
  });

  it("replays committed native stamps, including Compaction, without another publication", async () => {
    const meta = metadata(),
      facts: NativeAppend[] = [];
    const storage = new KafkaAckSessionStorage(meta, "a", async (f) => {
      if (f.kind === "append") facts.push(f);
    });
    await storage.appendEntry(message("root"), "main");
    await storage.createLane("child", "root");
    await storage.appendEntry(
      {
        id: "compact",
        type: "compaction",
        summary: "earlier work",
        retainedTail: [{ role: "user", content: "retained", timestamp: 1 }],
        tokensBefore: 10000,
      },
      "main",
    );
    await storage.appendEntry(message("after"), "main");
    await storage.appendEntry(message("child"), "child");
    await storage.setName("example");
    await storage.setLabel("root", "beginning");
    await storage.moveLane("child", "root");
    let publications = 0;
    const restored = await KafkaAckSessionStorage.restore(
      meta,
      "b",
      async () => {
        publications++;
      },
      facts.flatMap((f) => f.items),
    );
    expect(await restored.getLog()).toEqual(await storage.getLog());
    expect(await restored.getLanes()).toEqual(await storage.getLanes());
    expect(await restored.getName()).toBe("example");
    expect(await restored.getLabel("root")).toBe("beginning");
    expect(publications).toBe(0);
    expect(
      (await restored.findEntriesOnBranch({ start: "after", stopAtType: "compaction" })).map(
        (e) => e.id,
      ),
    ).toEqual(["after", "compact"]);
    expect((await restored.appendEntry(message("continued"), "main")).seq).toBe(9);
  });
});
