import { AsyncLocalStorage } from "node:async_hooks";

/** Native Tool task identity; no new lease, effect ledger or provider ID. */
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
