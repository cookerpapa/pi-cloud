export async function closeControlPlaneResources(
  resources: readonly (() => unknown | Promise<unknown>)[],
): Promise<void> {
  const errors: unknown[] = [];
  // Keep the drain order, but a failed close must not leak unrelated resources.
  for (const close of resources) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Control Plane resource cleanup failed");
}
