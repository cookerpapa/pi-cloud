import { Buffer } from "node:buffer";

export type NativeHistoryPosition = { sequence: number; ordinal: number };
export type HistoryPosition = NativeHistoryPosition & {
  version: 1;
  sessionId: string;
  originSessionId: string;
  turnId: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function encodeHistoryPosition(position: HistoryPosition): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}
export function decodeHistoryPosition(value: string, sessionId: string): HistoryPosition {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("Invalid history cursor");
  const p = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as HistoryPosition;
  if (
    p.version !== 1 ||
    p.sessionId !== sessionId ||
    !uuid.test(p.originSessionId) ||
    !uuid.test(p.turnId) ||
    !Number.isSafeInteger(p.sequence) ||
    p.sequence < 0 ||
    !Number.isSafeInteger(p.ordinal) ||
    p.ordinal < 0
  )
    throw new Error("History cursor does not belong to this view");
  return p;
}
export function compareNativeHistoryPosition(
  a: NativeHistoryPosition,
  b: NativeHistoryPosition,
): number {
  return a.sequence - b.sequence || a.ordinal - b.ordinal;
}
