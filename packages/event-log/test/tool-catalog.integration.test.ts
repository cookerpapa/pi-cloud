import { randomUUID, createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { KafkaToolCatalogConsumer, KafkaToolCatalogPublisher } from "../src/tool-catalog.ts";
import type { ToolCatalogPublication } from "@pi-cloud/protocol";

// The topic name is deliberately stable. Only the owned disposable RF3 driver
// may run this probe; an arbitrary developer-supplied broker is not permission.
it.skipIf(process.env.PI_CLOUD_ISOLATED_TOOL_CATALOG_CHECK !== "1")(
  "broadcasts retained snapshots to every boot and rejects a stale initialized publisher",
  async () => {
    const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS!.split(",");
    const options = { brokers, replicas: 3 };
    let selected = 1;
    const snapshot = (generation: number): ToolCatalogPublication => ({
      version: 1,
      scope: "platform",
      generation,
      releaseId: `release-${generation}`,
      replayable: [],
      catalog: { version: 4, tools: [], revision: createHash("sha256").update("[]").digest("hex") },
    });
    const publisher = new KafkaToolCatalogPublisher({
      ...options,
      instanceId: randomUUID(),
      authorize: async (value) => value.generation === selected,
    });
    const consumers: KafkaToolCatalogConsumer[] = [];
    const gates = Promise.withResolvers<void>();
    let checks = 0;
    const delayed = new KafkaToolCatalogPublisher({
      ...options,
      instanceId: randomUUID(),
      authorize: async (value) => {
        if (++checks === 2) await gates.promise;
        return value.generation === selected;
      },
    });
    const open = async () => {
      const consumer = new KafkaToolCatalogConsumer({
        ...options,
        instanceId: randomUUID(),
        minimumGeneration: async () => selected,
      });
      consumers.push(consumer);
      await consumer.start();
      return consumer;
    };
    try {
      await publisher.publish(snapshot(1));
      const first = await open(),
        second = await open();
      expect(first.view.snapshot?.generation).toBe(1);
      expect(second.view.snapshot?.generation).toBe(1);
      const stale = delayed.publish(snapshot(1));
      void stale.catch(() => {});
      await vi.waitFor(() => expect(checks).toBe(2), { timeout: 30000 });
      selected = 2;
      // The old delayed initializer has fenced publisher; a failed configuration
      // publication can be safely retried, unlike an uncertain shell effect.
      await publisher.publish(snapshot(2)).catch(() => publisher.publish(snapshot(2)));
      gates.resolve();
      await expect(stale).rejects.toThrow();
      await vi.waitFor(
        () => {
          expect(first.view.snapshot?.generation).toBe(2);
          expect(second.view.snapshot?.generation).toBe(2);
        },
        { timeout: 30000 },
      );
      const cold = await open();
      expect(cold.view.snapshot?.generation).toBe(2);
    } finally {
      gates.resolve();
      for (const consumer of consumers) await consumer.close();
      await delayed.close();
      await publisher.close();
    }
  },
  180000,
);
