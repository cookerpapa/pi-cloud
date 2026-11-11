/** Only short native API handoffs are held here. Tools run in the fixed Guest,
 * and PG owns resource intent. This barrier prevents a late SDK exec from
 * auto-starting a Box while its native stop/remove is in progress. */
export class AllocationAdmission {
  readonly #active = new Map<string, Set<Promise<unknown>>>();
  readonly #closing = new Map<string, Promise<void>>();

  use<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.#closing.has(id)) return Promise.reject(new Error("allocation_closing"));
    let active = this.#active.get(id);
    if (!active) this.#active.set(id, (active = new Set()));
    const work = Promise.resolve().then(action);
    active.add(work);
    const release = () => {
      active.delete(work);
      if (!active.size && this.#active.get(id) === active) this.#active.delete(id);
    };
    void work.then(release, release);
    return work;
  }

  close(id: string, action: () => Promise<void>): Promise<void> {
    const prior = this.#closing.get(id);
    if (prior) return prior;
    const work = Promise.resolve().then(async () => {
      await Promise.allSettled([...(this.#active.get(id) ?? [])]);
      await action();
    });
    this.#closing.set(id, work);
    // A failed close stays closed in this process. Retry only the mechanical
    // lifecycle action, never a command which could restart the resource.
    void work.then(
      () => this.#closing.delete(id),
      () => {},
    );
    return work;
  }

  retryClose(id: string, action: () => Promise<void>): Promise<void> {
    const prior = this.#closing.get(id);
    if (!prior) return this.close(id, action);
    return prior.catch(async () => {
      if (this.#closing.get(id) === prior) {
        this.#closing.delete(id);
        return this.close(id, action);
      }
      await this.#closing.get(id);
    });
  }
}
