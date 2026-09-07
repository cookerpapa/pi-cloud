import { SessionError } from "@earendil-works/pi-agent-core";
import type { PiSessionAppendOperation, PiSessionMutationOperation } from "./session-mutation.ts";

type Stamp = { id: string; seq: number; timestamp: number; parentId?: string | null };
type Receipt = { format: "append-stamps-v1"; items: Stamp[] };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Server-assigned metadata only; the caller already owns immutable input bodies. */
export function compactPiMutationResult(
  operation: PiSessionMutationOperation,
  result: unknown,
): unknown {
  const operations = appendOperations(operation);
  if (operations === undefined) return result;
  const values = operation.kind === "append_items" && record(result) ? result.items : [result];
  if (!Array.isArray(values) || values.length !== operations.length)
    throw new SessionError("storage", "Pi mutation result count changed");
  return {
    format: "append-stamps-v1",
    items: values.map((value, index) => {
      if (
        !record(value) ||
        typeof value.id !== "string" ||
        !Number.isSafeInteger(value.seq) ||
        !Number.isSafeInteger(value.timestamp)
      )
        throw new SessionError("storage", "Pi mutation result metadata was invalid");
      return {
        id: value.id,
        seq: value.seq,
        timestamp: value.timestamp,
        ...(operations[index]!.kind === "append_entry" ? { parentId: value.parentId } : {}),
      };
    }),
  };
}

export function restorePiMutationResult(
  operation: PiSessionMutationOperation,
  receipt: unknown,
): unknown {
  const operations = appendOperations(operation);
  if (operations === undefined) return receipt;
  if (
    !record(receipt) ||
    receipt.format !== "append-stamps-v1" ||
    !Array.isArray(receipt.items) ||
    receipt.items.length !== operations.length
  )
    throw new SessionError("storage", "Pi append receipt was invalid");
  const items = (receipt as unknown as Receipt).items.map((stamp, index) => {
    const input = operations[index]!;
    const original = input.kind === "append_entry" ? input.entry : input.record;
    if (
      stamp.id !== original.id ||
      !Number.isSafeInteger(stamp.seq) ||
      !Number.isSafeInteger(stamp.timestamp) ||
      (input.kind === "append_entry" &&
        stamp.parentId !== null &&
        typeof stamp.parentId !== "string")
    )
      throw new SessionError("storage", "Pi append receipt identity changed");
    return {
      ...structuredClone(original),
      id: stamp.id,
      seq: stamp.seq,
      timestamp: stamp.timestamp,
      ...(input.kind === "append_entry" ? { parentId: stamp.parentId } : {}),
    };
  });
  return operation.kind === "append_items" ? { items } : items[0];
}

function appendOperations(
  operation: PiSessionMutationOperation,
): readonly PiSessionAppendOperation[] | undefined {
  return operation.kind === "append_items"
    ? operation.items
    : operation.kind === "append_entry" || operation.kind === "append_record"
      ? [operation]
      : undefined;
}
