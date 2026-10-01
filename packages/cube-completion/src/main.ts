import { readFile } from "node:fs/promises";
import { createDatabase } from "@pi-cloud/database";
import { KafkaToolReplyPublisher, ToolProgressPublisher } from "@pi-cloud/event-log";
import { configuredImageAttachments } from "@pi-cloud/session-attachments";
import { CubeCompletionAdapter, type CompletionPacket } from "./adapter.ts";
import { completionFrames } from "./frames.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
async function main(): Promise<void> {
  const cleanup: Array<() => Promise<unknown>> = [];
  const active = new Set<Promise<void>>();
  try {
    const database = createDatabase({
      connectionString: (await readFile(required("PI_CLOUD_DATABASE_URL_FILE"), "utf8")).trim(),
      maxConnections: 4,
    });
    cleanup.push(() => database.destroy());
    const images = await configuredImageAttachments(database);
    if (images) cleanup.push(async () => images.blobs.close());
    const publisher = new KafkaToolReplyPublisher(
      required("PI_CLOUD_KAFKA_BROKERS").split(","),
      `cube-completion-${process.pid}`,
    );
    cleanup.push(() => publisher.close());
    await publisher.start();
    const progress = new ToolProgressPublisher(
      required("PI_CLOUD_CONTROL_PLANE_URL"),
      (await readFile(required("PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE"), "utf8")).trim(),
    );
    cleanup.push(() => progress.close());
    const adapter = new CubeCompletionAdapter({
      ...(images ? { images: images.codec } : {}),
      progress,
      publish: (topic, reply) => publisher.publish(topic, reply),
    });
    process.stdout.write('{"type":"ready","protocolVersion":1}\n');
    for await (const line of completionFrames(process.stdin)) {
      const packet = JSON.parse(line) as CompletionPacket;
      if (packet.kind === "progress") {
        void adapter.accept(packet).catch(() => {});
        continue;
      }
      if (!packet.id || active.size >= 32) {
        process.stdout.write(JSON.stringify({ id: packet.id, delivered: false }) + "\n");
        continue;
      }
      const task = adapter.accept(packet).then(
        () => {
          process.stdout.write(JSON.stringify({ id: packet.id, delivered: true }) + "\n");
        },
        () => {
          process.stdout.write(JSON.stringify({ id: packet.id, delivered: false }) + "\n");
        },
      );
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  } finally {
    await Promise.allSettled(active);
    for (const close of cleanup.reverse()) await close().catch(() => {});
  }
}
void main().catch(() => {
  process.stderr.write("cube_completion_adapter_failed\n");
  process.exitCode = 1;
});
