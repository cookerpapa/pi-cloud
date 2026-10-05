import { TOOL_CANCELLATION_UNKNOWN } from "@pi-cloud/protocol";
import { confirmsNoToolEffect } from "./tool-execution-outcome.ts";

/** Pi still awaits the original Tool promise. Cancellation acceptance is never
 * substituted for its final result, and publication loss cannot replay Bash. */
export async function awaitCancelledToolReply<T>(options: {
  reply: Promise<T>;
  signal?: AbortSignal;
  received(): boolean;
  cancel(): Promise<void>;
  abortWait(reason: Error): void;
  unconfirmed(): void;
  timeoutMs: number;
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let requested = false;
  const abort = () => {
    if (requested || options.received()) return;
    requested = true;
    timer = setTimeout(
      () => options.abortWait(new Error(TOOL_CANCELLATION_UNKNOWN)),
      options.timeoutMs,
    );
    // The final reply may race a lost publication ACK. Keep waiting for that
    // result within the same budget, regardless of cancellation send outcome.
    void Promise.resolve()
      .then(options.cancel)
      .catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await options.reply;
  } catch (cause) {
    if (!options.signal?.aborted || confirmsNoToolEffect(cause)) throw cause;
    options.unconfirmed();
    throw new Error(TOOL_CANCELLATION_UNKNOWN, { cause });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
