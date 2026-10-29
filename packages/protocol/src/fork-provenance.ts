/** Code-owned provenance data. This plain document specification imports no Pi
 * runtime; the cold Storage adapter and trusted Runner bind it through defineDoc. */
export type ForkProvenance = {
  sessionId: string;
  sourceSessionId: string;
  sourceEntryId: string;
};
export type ForkProvenanceState = { origin: ForkProvenance | null };
export const FORK_PROVENANCE_DOCUMENT = {
  kind: "pi-cloud.fork-origin",
  version: 1,
  scope: "session",
  initial: (): ForkProvenanceState => ({ origin: null }),
} as const;
