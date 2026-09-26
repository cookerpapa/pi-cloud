import { AsyncLocalStorage } from "node:async_hooks";

/** Native result Entry identity; no new lease, effect ledger or provider ID. */
export type ToolInvocation = Readonly<{ id: string; nativeToolCallId: string }>;
const current = new AsyncLocalStorage<ToolInvocation>();

export function withToolInvocation<T>(invocation: ToolInvocation, action: () => T): T {
  return current.run(invocation, action);
}

export function toolInvocationId(nativeToolCallId: string): string {
  const invocation = current.getStore();
  if (!invocation || invocation.nativeToolCallId !== nativeToolCallId)
    throw new Error("Tool invocation is outside its trusted Runner scope");
  return invocation.id;
}

/** One response at a time per Lane. Preparation and final Result share an ID. */
export class ToolInvocations {
  readonly #results = new Map<string, string>();
  constructor(readonly nextId: () => string) {}
  beginSampling(): void {
    this.#results.clear();
  }
  resultEntryId(nativeToolCallId: string): string {
    let id = this.#results.get(nativeToolCallId);
    if (!id) {
      id = this.nextId();
      this.#results.set(nativeToolCallId, id);
    }
    return id;
  }
}
