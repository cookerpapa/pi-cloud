import type { UserUpload } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";

/** Restore before acknowledging. A failed/lost acknowledgement may return the
 * same page again; never append its text twice to the still-open draft. */
export async function restoreReturnedInputs(
  api: Pick<PiCloudApi, "getReturnedInputs" | "acknowledgeReturnedInputs">,
  sessionId: string,
  restored: Set<string>,
  append: (text: string, uploads: UserUpload[]) => boolean | void,
  signal: AbortSignal,
): Promise<"pending" | "done"> {
  while (true) {
    signal.throwIfAborted();
    const page = await api.getReturnedInputs(sessionId, signal);
    signal.throwIfAborted();
    if (page.sessionId !== sessionId) throw new Error("Returned input scope changed");
    if (page.pending) return "pending";
    if (!page.items.length) return "done";
    const fresh = page.items.filter((item) => !restored.has(item.turnId));
    if (fresh.length) {
      if (
        append(
          fresh
            .map((i) => i.text)
            .filter(Boolean)
            .join("\n\n"),
          fresh.flatMap((i) => i.uploads),
        ) === false
      )
        throw new Error("Could not restore input attachments");
      for (const item of fresh) restored.add(item.turnId);
    }
    await api.acknowledgeReturnedInputs(
      sessionId,
      page.items.map((i) => i.turnId),
      signal,
    );
    signal.throwIfAborted();
    if (!page.hasMore) return "done";
  }
}
