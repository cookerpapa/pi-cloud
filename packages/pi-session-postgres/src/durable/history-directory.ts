import { createHash, randomUUID } from "node:crypto";

/** A leaf fixes a published subset of one immutable record stream. ID order is
 * native context order; throughSequence freezes which IDs had actually arrived. */
export type HistoryRange = Readonly<{
  sourceId: string;
  conversationId: number;
  throughSequence: number;
  clearTask: boolean;
  retainedTasks?: readonly number[];
  minId: number;
  maxId: number;
  count: number;
  fingerprint: string;
}>;
export type HistoryCoordinates = Readonly<{
  minId: number;
  maxId: number;
  count: number;
  fingerprint: string;
}>;
type Summary = Readonly<{ minId: number; maxId: number; count: number; height: number }>;
export type HistoryDirectoryNode<R extends HistoryCoordinates = HistoryRange> = Summary &
  Readonly<{
    id: string;
    digest: string;
  }> &
  (
    | Readonly<{ kind: "range"; range: R }>
    | Readonly<{
        kind: "branch";
        left: string;
        right: string;
        leftDigest: string;
        rightDigest: string;
      }>
  );
type DraftNode<R extends HistoryCoordinates> =
  HistoryDirectoryNode<R> extends infer N
    ? N extends HistoryDirectoryNode<R>
      ? Omit<N, "id" | "digest">
      : never
    : never;
export interface HistoryDirectoryStore<R extends HistoryCoordinates = HistoryRange> {
  read(id: string): Promise<HistoryDirectoryNode<R> | undefined>;
  /** Atomic insertion and root ownership are committed by the caller's PG transaction. */
  insert(nodes: readonly HistoryDirectoryNode<R>[]): Promise<void>;
  /** Must keep the original publication bound; never substitute the stream's latest head. */
  clip(range: R, maximumId: number): Promise<R | undefined>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function digest<R extends HistoryCoordinates>(
  value: Omit<HistoryDirectoryNode<R>, "digest">,
): string {
  const { digest: _digest, ...node } = value as HistoryDirectoryNode<R>;
  return createHash("sha256")
    .update(JSON.stringify(stable(node)))
    .digest("hex");
}
function identity(range: HistoryCoordinates): string {
  const { minId: _min, maxId: _max, count: _count, fingerprint: _fingerprint, ...source } = range;
  return JSON.stringify(stable(source));
}

/** Persistent AVL directory. It does not require publication in native ID order,
 * and does not treat a balanced directory as proof that its ID intervals are disjoint. */
export class HistoryDirectory<R extends HistoryCoordinates = HistoryRange> {
  readonly #cache = new Map<string, HistoryDirectoryNode<R>>();
  readonly #created = new Map<string, HistoryDirectoryNode<R>>();
  constructor(readonly store: HistoryDirectoryStore<R>) {}

  async read(id: string): Promise<HistoryDirectoryNode<R>> {
    const cached = this.#cache.get(id);
    if (cached) return cached;
    const node = await this.store.read(id);
    if (!node || node.id !== id || node.digest !== digest(node))
      throw new Error("Retained history directory integrity check failed");
    this.#cache.set(id, node);
    return node;
  }

  #create(value: DraftNode<R>): HistoryDirectoryNode<R> {
    const pending = { id: randomUUID(), ...value };
    const node = { ...pending, digest: digest(pending) } as HistoryDirectoryNode<R>;
    this.#cache.set(node.id, node);
    this.#created.set(node.id, node);
    return node;
  }

  range(range: R): HistoryDirectoryNode<R> {
    if (
      ![range.minId, range.maxId, range.count].every(Number.isSafeInteger) ||
      range.minId < 1 ||
      range.maxId < range.minId ||
      range.count < 1 ||
      !/^[0-9a-f]{64}$/.test(range.fingerprint)
    )
      throw new Error("Invalid retained history range");
    return this.#create({
      kind: "range",
      range: structuredClone(range),
      minId: range.minId,
      maxId: range.maxId,
      count: range.count,
      height: 1,
    });
  }

  #pair(left: HistoryDirectoryNode<R>, right: HistoryDirectoryNode<R>): HistoryDirectoryNode<R> {
    return this.#create({
      kind: "branch",
      left: left.id,
      right: right.id,
      leftDigest: left.digest,
      rightDigest: right.digest,
      minId: Math.min(left.minId, right.minId),
      maxId: Math.max(left.maxId, right.maxId),
      count: left.count + right.count,
      height: Math.max(left.height, right.height) + 1,
    });
  }

  async #children(
    node: HistoryDirectoryNode<R>,
  ): Promise<readonly [HistoryDirectoryNode<R>, HistoryDirectoryNode<R>]> {
    if (node.kind !== "branch") throw new Error("History directory height is inconsistent");
    const [left, right] = await Promise.all([this.read(node.left), this.read(node.right)]);
    if (
      left.digest !== node.leftDigest ||
      right.digest !== node.rightDigest ||
      node.height !== Math.max(left.height, right.height) + 1 ||
      node.count !== left.count + right.count ||
      node.minId !== Math.min(left.minId, right.minId) ||
      node.maxId !== Math.max(left.maxId, right.maxId)
    )
      throw new Error("Retained history directory branch changed");
    return [left, right];
  }

  async #balance(
    left: HistoryDirectoryNode<R>,
    right: HistoryDirectoryNode<R>,
  ): Promise<HistoryDirectoryNode<R>> {
    if (left.height > right.height + 1) {
      const [a, b] = await this.#children(left);
      if (a.height >= b.height) return this.#pair(a, this.#pair(b, right));
      const [c, d] = await this.#children(b);
      return this.#pair(this.#pair(a, c), this.#pair(d, right));
    }
    if (right.height > left.height + 1) {
      const [a, b] = await this.#children(right);
      if (b.height >= a.height) return this.#pair(this.#pair(left, a), b);
      const [c, d] = await this.#children(a);
      return this.#pair(this.#pair(left, c), this.#pair(d, b));
    }
    return this.#pair(left, right);
  }

  async join(
    left: HistoryDirectoryNode<R> | undefined,
    right: HistoryDirectoryNode<R> | undefined,
  ): Promise<HistoryDirectoryNode<R> | undefined> {
    if (!left || !right) return left ?? right;
    if (left.height > right.height + 1) {
      const [a, b] = await this.#children(left);
      return this.#balance(a, (await this.join(b, right))!);
    }
    if (right.height > left.height + 1) {
      const [a, b] = await this.#children(right);
      return this.#balance((await this.join(left, a))!, b);
    }
    return this.#pair(left, right);
  }

  async prefix(
    node: HistoryDirectoryNode<R> | undefined,
    maximumId: number,
  ): Promise<HistoryDirectoryNode<R> | undefined> {
    if (!node || maximumId < node.minId) return undefined;
    if (node.maxId <= maximumId) return node;
    if (node.kind === "range") {
      const clipped = await this.store.clip(node.range, maximumId);
      if (!clipped) return undefined;
      if (
        identity(clipped) !== identity(node.range) ||
        clipped.minId < node.range.minId ||
        clipped.maxId > maximumId ||
        clipped.count > node.count
      )
        throw new Error("Clipped history escaped its snapshot boundary");
      return this.range(clipped);
    }
    const [left, right] = await this.#children(node);
    // Both sides can overlap the cutoff for valid out-of-order Storage writes.
    return this.join(await this.prefix(left, maximumId), await this.prefix(right, maximumId));
  }

  /** Transform selected boundary ranges, sharing every unchanged subtree. */
  async mapRanges(
    node: HistoryDirectoryNode<R> | undefined,
    select: (range: R) => Promise<R | undefined>,
  ): Promise<HistoryDirectoryNode<R> | undefined> {
    if (!node) return undefined;
    if (node.kind === "range") {
      const range = await select(node.range);
      return range === node.range ? node : range ? this.range(range) : undefined;
    }
    const [left, right] = await this.#children(node);
    const a = await this.mapRanges(left, select),
      b = await this.mapRanges(right, select);
    return a?.id === left.id && b?.id === right.id ? node : this.join(a, b);
  }

  /** Only newly created nodes reachable from the chosen root are inserted. */
  async persist(root: HistoryDirectoryNode<R> | undefined): Promise<string | null> {
    if (!root) return null;
    const pending: HistoryDirectoryNode<R>[] = [],
      seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = this.#created.get(id);
      if (!node) return;
      if (node.kind === "branch") {
        visit(node.left);
        visit(node.right);
      }
      pending.push(node);
    };
    visit(root.id);
    if (pending.length) await this.store.insert(pending);
    for (const node of pending) this.#created.delete(node.id);
    return root.id;
  }
}
