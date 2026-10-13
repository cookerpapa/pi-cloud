import { producer, processResources } from "./client.mjs";

process.once("message", async ({ brokers, topic, count }) => {
  const producers = [];
  try {
    const before = await processResources(),
      opening = performance.now();
    for (let i = 0; i < count; i++) {
      const p = await producer(brokers, `${topic}-session-${i}`);
      producers.push(p);
      await p.send(topic, `session-${i}`, { sample: "warmup", i });
    }
    const initializationMs = performance.now() - opening;
    const latencies = [];
    for (let round = 0; round < 3; round++)
      for (const [i, p] of producers.entries()) {
        const at = performance.now();
        await p.send(topic, `session-${i}`, { sample: "commit", round, i });
        latencies.push(performance.now() - at);
      }
    const after = await processResources(),
      sorted = latencies.toSorted((a, b) => a - b);
    process.send({
      count,
      before,
      after,
      delta: Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]])),
      initializationMs,
      warmTransactionMs: {
        samples: sorted.length,
        p50: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      },
    });
  } catch (error) {
    process.send({ error: error.message });
    process.exitCode = 1;
  } finally {
    const closed = await Promise.allSettled(producers.map((p) => p.close()));
    if (closed.some((result) => result.status === "rejected")) process.exitCode = 1;
    process.disconnect();
  }
});
