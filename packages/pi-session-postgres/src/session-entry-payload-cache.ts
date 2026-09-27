const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAXIMUM_ENTRY_BYTES = 8 * 1024 * 1024;

type CachedPayload = Readonly<{
  payload: Record<string, unknown>;
  bytes: number;
}>;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be positive`);
  return value;
}

function key(tenantId: string, sessionId: string, entryId: string): string {
  return `${tenantId}\0${sessionId}\0${entryId}`;
}

/**
 * Bounded per-Worker cache for immutable Pi entry payloads.
 *
 * Delegated Lanes share their physical Session; Forks own independent copies.
 * Cold reads may reuse immutable payloads already loaded on this
 * Worker, but placement and recovery never depend on a cache hit.
 */
export class PostgresPiSessionEntryPayloadCache {
  readonly #maximumBytes: number;
  readonly #maximumEntryBytes: number;
  readonly #entries = new Map<string, CachedPayload>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: { maximumBytes?: number; maximumEntryBytes?: number } = {}) {
    this.#maximumBytes = positiveInteger(
      options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES,
      "Pi Session entry-cache byte limit",
    );
    this.#maximumEntryBytes = positiveInteger(
      options.maximumEntryBytes ?? DEFAULT_MAXIMUM_ENTRY_BYTES,
      "Pi Session entry-cache item limit",
    );
    if (this.#maximumEntryBytes > this.#maximumBytes) {
      throw new TypeError("Pi Session entry-cache item limit exceeds its total limit");
    }
  }

  get(tenantId: string, sessionId: string, entryId: string): Record<string, unknown> | undefined {
    const identity = key(tenantId, sessionId, entryId);
    const cached = this.#entries.get(identity);
    if (cached === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    this.#entries.delete(identity);
    this.#entries.set(identity, cached);
    return structuredClone(cached.payload);
  }

  set(
    tenantId: string,
    sessionId: string,
    entryId: string,
    payload: Record<string, unknown>,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > this.#maximumEntryBytes) return;
    const identity = key(tenantId, sessionId, entryId);
    const previous = this.#entries.get(identity);
    if (previous !== undefined) this.#bytes -= previous.bytes;
    this.#entries.delete(identity);
    this.#entries.set(identity, { payload: structuredClone(payload), bytes });
    this.#bytes += bytes;
    while (this.#bytes > this.#maximumBytes) {
      const oldest = this.#entries.entries().next().value as [string, CachedPayload] | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
    }
  }

  snapshot(): Readonly<{ entries: number; bytes: number; hits: number; misses: number }> {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
    };
  }
}
