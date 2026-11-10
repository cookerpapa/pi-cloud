import type { SandboxLifecycleCursor, SandboxLifecyclePage } from "@pi-cloud/protocol";

/** Provider facts, not a second resource controller or provider price API. */
export interface SandboxLifecycleSource {
  readonly id: string;
  close?(): void | Promise<void>;
  list(signal: AbortSignal): Promise<Array<{ id: string; available: boolean }>>;
  read(
    id: string,
    cursor: SandboxLifecycleCursor | undefined,
    signal: AbortSignal,
    waitMs?: number,
  ): Promise<SandboxLifecyclePage>;
}
/** History and notification share a cursor, avoiding a subscribe/bootstrap gap. */
export async function* watchSandboxLifecycle(
  source: SandboxLifecycleSource,
  id: string,
  cursor: SandboxLifecycleCursor | undefined,
  signal: AbortSignal,
): AsyncGenerator<SandboxLifecyclePage> {
  while (!signal.aborted) {
    const page = await source.read(id, cursor, signal, 20_000);
    yield page;
    cursor = {
      epoch: page.epoch,
      sequence: page.next,
      ...(page.sourcePosition ? { sourcePosition: page.sourcePosition } : {}),
    };
  }
}
