import { createDatabase } from "@pi-cloud/database";
import { KafkaProjectionRuntime } from "@pi-cloud/runtime-core/kafka-projection-runtime";
import { startServiceObservability } from "@pi-cloud/observability";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { loadProducerCapacity } from "@pi-cloud/runtime-core/kafka-accepted-fact";

const path = process.env.DATABASE_URL_FILE;
if (!path) throw new Error("DATABASE_URL_FILE is required");
const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
let connectionString: string;
try {
  const stat = await file.stat();
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16384)
    throw new Error("Database secret is not a private bounded file");
  connectionString = (await file.readFile("utf8")).trim();
} finally {
  await file.close();
}
const integer = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};
const brokers = process.env.PI_CLOUD_KAFKA_BROKERS?.split(",").filter(Boolean);
if (!brokers?.length) throw new Error("PI_CLOUD_KAFKA_BROKERS is required");
const database = createDatabase({
  connectionString,
  maxConnections: integer("PI_CLOUD_PROJECTION_DATABASE_CONNECTIONS", 8),
});
const observability = await startServiceObservability({
  serviceName: "pi-cloud-canonical-projector",
  defaultMetricsPort: 9470,
});
const runtime = new KafkaProjectionRuntime({
  capacity: loadProducerCapacity(process.env),
  metrics: observability.metrics,
  database,
  brokers,
  clientId: `projection-${randomUUID()}`,
  partitions: integer("PI_CLOUD_KAFKA_PARTITIONS", 32),
  replicas: integer("PI_CLOUD_KAFKA_REPLICAS", 3),
  retentionMs: integer("PI_CLOUD_ACCEPTED_FACT_RETENTION_MS", 7200000),
});
const server = createServer((_request, response) => {
  void runtime.checkHealth().then(
    () => {
      response.writeHead(200);
      response.end("ready");
    },
    () => {
      response.writeHead(503);
      response.end("unavailable");
    },
  );
});
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    server.close();
    await runtime.close();
    await database.destroy();
    await observability.close();
  })());
try {
  await runtime.start();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(integer("PORT", 3000), "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
} catch (error) {
  await close();
  throw error;
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
