/** Bounded in-flight work; messages on one partition never overtake each other. */
export async function consumePartitioned<T extends { partition: number }>(
  messages: AsyncIterable<T>,
  handle: (message: T) => Promise<void>,
  maximumPending = 256,
): Promise<void> {
  const tails = new Map<number, Promise<void>>();
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  try {
    for await (const message of messages) {
      while (pending.size >= maximumPending) await Promise.race(pending);
      if (failure !== undefined) throw failure;
      const previous = tails.get(message.partition) ?? Promise.resolve();
      const task = previous
        .then(async () => {
          if (failure === undefined) await handle(message);
        })
        .catch((error: unknown) => {
          failure ??= error;
        })
        .finally(() => {
          pending.delete(task);
          if (tails.get(message.partition) === task) tails.delete(message.partition);
        });
      tails.set(message.partition, task);
      pending.add(task);
    }
  } finally {
    await Promise.all(pending);
  }
  if (failure !== undefined) throw failure;
}
