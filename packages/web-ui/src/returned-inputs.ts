import type { ReturnedInput } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";

export type InputReturnRecovery = {
  restored: Set<string>;
  requestId: string | null;
  afterPosition: number;
};
export const inputReturnRecovery = (): InputReturnRecovery => ({
  restored: new Set(),
  requestId: null,
  afterPosition: 0,
});

/** Cursor and restored identities belong to the open composer. Read immutable
 * pages for one Stop; acknowledge that batch only after all its inputs arrive. */
export async function restoreReturnedInputs(
  api: Pick<PiCloudApi, "getReturnedInputs" | "acknowledgeReturnedInputs">,
  sessionId: string,
  recovery: InputReturnRecovery,
  append: (items: readonly ReturnedInput[]) => boolean | void,
  signal: AbortSignal,
): Promise<"pending" | "done"> {
  while (true) {
    signal.throwIfAborted();
    const page = await api.getReturnedInputs(
      sessionId,
      signal,
      recovery.requestId
        ? { requestId: recovery.requestId, afterPosition: recovery.afterPosition }
        : {},
    );
    signal.throwIfAborted();
    if (
      page.sessionId !== sessionId ||
      (recovery.requestId && page.requestId !== recovery.requestId)
    )
      throw new Error("Returned input scope changed");
    if (!page.requestId) return "done";
    recovery.requestId = page.requestId;
    if (page.pending) return "pending";
    const fresh = page.items.filter((item) => !recovery.restored.has(item.inputId));
    if (fresh.length) {
      if (append(fresh) === false) throw new Error("Could not restore input attachments");
      for (const item of fresh) recovery.restored.add(item.inputId);
    }
    const last = page.items.at(-1);
    if (last) recovery.afterPosition = last.mailboxPosition;
    if (page.hasMore) {
      if (!last || last.mailboxPosition <= page.afterPosition)
        throw new Error("Returned input page did not advance");
      continue;
    }
    await api.acknowledgeReturnedInputs(sessionId, page.requestId, signal);
    signal.throwIfAborted();
    recovery.requestId = null;
    recovery.afterPosition = 0;
  }
}
