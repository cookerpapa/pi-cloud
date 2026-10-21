import { createHash } from "node:crypto";
import {
  parseControlToolCatalog,
  type ControlToolCatalog,
  type ControlToolCatalogSource,
} from "@pi-cloud/protocol";

/** One disposable snapshot per Worker, shared by active native Session registries. */
export class WorkerToolCatalog implements ControlToolCatalogSource {
  #current: ControlToolCatalog | undefined;
  readonly #listeners = new Set<() => void>();
  get ready(): boolean {
    return this.#current !== undefined;
  }
  read(): ControlToolCatalog {
    if (!this.#current) throw new Error("Control Tool catalog is not available");
    return this.#current;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  update(value: unknown): void {
    const next = parseControlToolCatalog(value);
    if (createHash("sha256").update(JSON.stringify(next.tools)).digest("hex") !== next.revision)
      throw new TypeError("Control Tool catalog revision does not match its definitions");
    if (this.#current?.revision === next.revision) return;
    this.#current = next;
    for (const listener of this.#listeners) listener();
  }
}
