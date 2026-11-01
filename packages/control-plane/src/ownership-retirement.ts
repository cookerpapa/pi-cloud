/** Wait for startup to stop acquiring resources before closing them. A stuck
 * startup/cleanup cannot leave a permanently fenced process serving forever. */
export function ownershipRetirement(options: {
  startupSettled: Promise<void>;
  close(): Promise<void>;
  fail(): void;
  exit(): void;
  cleanupFailed(): void;
  deadlineMs?: number;
}): () => void {
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    options.fail();
    const deadline = setTimeout(options.exit, options.deadlineMs ?? 30_000);
    deadline.unref();
    // Keep the exit armed even after cleanup: a leaked handle must not prevent
    // replacement. The unref timer does not keep a fully closed process alive.
    void options.startupSettled.then(options.close).catch(() => options.cleanupFailed());
  };
}
