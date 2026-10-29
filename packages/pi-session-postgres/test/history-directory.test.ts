import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  HistoryDirectory,
  type HistoryDirectoryNode,
  type HistoryDirectoryStore,
  type HistoryRange,
} from "../src/durable/history-directory.ts";

function fixture() {
  const nodes = new Map<string, HistoryDirectoryNode>();
  const records = new Map<string, { id: number; seq: number; text: string }[]>();
  let reads = 0,
    writes = 0;
  const snapshot = (
    sourceId: string,
    maximumId: number,
    throughSequence: number,
    minimumId = 2,
  ): HistoryRange | undefined => {
    const visible = (records.get(sourceId) ?? [])
      .filter((e) => e.id >= minimumId && e.id <= maximumId && e.seq <= throughSequence)
      .sort((a, b) => a.id - b.id);
    if (!visible.length) return undefined;
    return {
      sourceId,
      conversationId: 1,
      throughSequence,
      clearTask: true,
      minId: visible[0]!.id,
      maxId: visible.at(-1)!.id,
      count: visible.length,
      fingerprint: createHash("sha256").update(JSON.stringify(visible)).digest("hex"),
    };
  };
  const store: HistoryDirectoryStore = {
    async read(id) {
      reads++;
      return structuredClone(nodes.get(id));
    },
    async insert(batch) {
      for (const n of batch) {
        expect(nodes.has(n.id)).toBe(false);
        if (n.kind === "branch") {
          expect(nodes.has(n.left)).toBe(true);
          expect(nodes.has(n.right)).toBe(true);
        }
        nodes.set(n.id, structuredClone(n));
        writes++;
      }
    },
    async clip(range, maximumId) {
      return snapshot(range.sourceId, maximumId, range.throughSequence, range.minId);
    },
  };
  async function visible(id: string): Promise<{ id: number; text: string }[]> {
    const n = nodes.get(id)!;
    if (n.kind === "range")
      return (records.get(n.range.sourceId) ?? [])
        .filter((e) => e.id >= n.minId && e.id <= n.maxId && e.seq <= n.range.throughSequence)
        .map(({ id, text }) => ({ id, text }));
    return [...(await visible(n.left)), ...(await visible(n.right))].sort((a, b) => a.id - b.id);
  }
  return { nodes, records, store, snapshot, visible, counts: () => ({ reads, writes }) };
}

it("freezes publication membership separately from native ID order", async () => {
  const f = fixture();
  f.records.set("source", [
    { id: 30, seq: 1, text: "C" },
    { id: 10, seq: 1, text: "A" },
    { id: 20, seq: 1, text: "B" },
  ]);
  const d = new HistoryDirectory(f.store),
    root = d.range(f.snapshot("source", 30, 1)!);
  await d.persist(root);
  // A valid lower-level caller can publish a reserved ID later. It cannot enter the frozen view.
  f.records.get("source")!.push({ id: 15, seq: 2, text: "LATE" });
  const reopened = new HistoryDirectory(f.store);
  const fork = await reopened.prefix(await reopened.read(root.id), 20);
  await reopened.persist(fork);
  expect(await f.visible(fork!.id)).toEqual([
    { id: 10, text: "A" },
    { id: 20, text: "B" },
  ]);
  expect((await f.visible(root.id)).map((e) => e.text)).toEqual(["C", "A", "B"]);
});

it("clips overlapping ID intervals without treating a balanced tree as globally ordered publication", async () => {
  const f = fixture();
  f.records.set("one", [
    { id: 10, seq: 1, text: "A" },
    { id: 30, seq: 2, text: "C" },
  ]);
  f.records.set("two", [
    { id: 20, seq: 3, text: "B" },
    { id: 40, seq: 4, text: "D" },
  ]);
  const d = new HistoryDirectory(f.store);
  const root = await d.join(d.range(f.snapshot("one", 30, 4)!), d.range(f.snapshot("two", 40, 4)!));
  await d.persist(root);
  const next = new HistoryDirectory(f.store);
  const fork = await next.prefix(await next.read(root!.id), 25);
  await next.persist(fork);
  expect(await f.visible(fork!.id)).toEqual([
    { id: 10, text: "A" },
    { id: 20, text: "B" },
  ]);
  expect(root!.count).toBe(4);
  expect(fork!.count).toBe(2);
});

it("shares a thousand nested roots with logarithmic directory height and bounded path changes", async () => {
  const f = fixture();
  let id: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const source = `source-${i}`;
    f.records.set(source, [{ id: i + 2, seq: i + 1, text: source }]);
    const d = new HistoryDirectory(f.store),
      before = f.counts();
    const root = await d.join(
      id ? await d.read(id) : undefined,
      d.range(f.snapshot(source, i + 2, i + 1)!),
    );
    id = await d.persist(root);
    expect(root!.height).toBeLessThan(16);
    expect(f.counts().writes - before.writes).toBeLessThan(20);
  }
  expect(await f.visible(id!)).toHaveLength(1000);
  const d = new HistoryDirectory(f.store),
    prior = f.counts(),
    root = await d.read(id!);
  const fork = await d.prefix(root, 501);
  await d.persist(fork);
  expect(f.counts().reads - prior.reads).toBeLessThan(40);
  expect(f.counts().writes - prior.writes).toBeLessThan(20);
  expect(await f.visible(fork!.id)).toHaveLength(500);
  expect(await f.visible(id!)).toHaveLength(1000);
});

it("does not publish temporary rotations, verifies stored metadata and rejects a moving snapshot", async () => {
  const f = fixture();
  f.records.set("source", [
    { id: 10, seq: 1, text: "A" },
    { id: 20, seq: 1, text: "B" },
  ]);
  const d = new HistoryDirectory(f.store),
    root = d.range(f.snapshot("source", 20, 1)!);
  d.range(f.snapshot("source", 10, 1)!); // An abandoned branch has no owner.
  await d.persist(root);
  expect(f.nodes.size).toBe(1);
  const moving = new HistoryDirectory({
    ...f.store,
    clip: async (range) => ({ ...range, maxId: 10, throughSequence: 2 }),
  });
  await expect(moving.prefix(await moving.read(root.id), 10)).rejects.toThrow("snapshot boundary");
  f.nodes.set(root.id, { ...root, count: 100 });
  await expect(new HistoryDirectory(f.store).read(root.id)).rejects.toThrow("integrity");
});
