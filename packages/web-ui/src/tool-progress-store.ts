import { ToolPreviewBuffer, type ToolPreviewState, type ToolProgress } from "@pi-cloud/protocol";

/** Only mounted running Tool cards retain observations; never part of SessionView. */
export class ToolProgressStore {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #values = new Map<string, { operationId: string; buffer: ToolPreviewBuffer }>();
  subscribe(key: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(key);
    if (!listeners) this.#listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        this.#listeners.delete(key);
        this.#values.delete(key);
      }
    };
  }
  get(key: string): ToolPreviewState | undefined {
    return this.#values.get(key)?.buffer.current;
  }
  receive(progress: ToolProgress): void {
    const key = `${progress.turnId}\0${progress.toolCallId}`;
    const listeners = this.#listeners.get(key);
    if (!listeners) return;
    let view = this.#values.get(key);
    if (view && view.operationId !== progress.operationId) return;
    if (!view) {
      view = { operationId: progress.operationId, buffer: new ToolPreviewBuffer() };
      this.#values.set(key, view);
    }
    try {
      if (!view.buffer.accept(progress.update)) return;
    } catch {
      return;
    }
    for (const listener of listeners) listener();
  }
  reset(): void {
    this.#values.clear();
    for (const listeners of this.#listeners.values()) for (const listener of listeners) listener();
  }
}
