import { ToolCompletionCapabilities } from "@pi-cloud/protocol/completion-capability";
import { readFile } from "node:fs/promises";
import { createDatabase } from "@pi-cloud/database/client";
import { sql } from "kysely";
import { KafkaToolReplyPublisher, ToolProgressPublisher } from "@pi-cloud/event-log";
import { configuredImageAttachments } from "@pi-cloud/session-attachments";
import { CubeCompletionAdapter } from "./adapter.ts";
import { completionServer } from "./http-server.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const secret = async (name: string) => (await readFile(required(name), "utf8")).trim();
async function main(): Promise<void> {
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const database = createDatabase({
      connectionString: await secret("DATABASE_URL_FILE"),
      maxConnections: 4,
    });
    cleanup.push(() => database.destroy());
    const images = await configuredImageAttachments(database);
    if (images) cleanup.push(async () => images.blobs.close());
    const publisher = new KafkaToolReplyPublisher(
      required("PI_CLOUD_KAFKA_BROKERS").split(","),
      `tool-completion-${process.pid}`,
    );
    cleanup.push(() => publisher.close());
    await publisher.start();
    const managementToken = await secret("PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE");
    const progress = new ToolProgressPublisher(
      required("PI_CLOUD_CONTROL_PLANE_URL"),
      managementToken,
    );
    cleanup.push(() => progress.close());
    const adapter = new CubeCompletionAdapter({
      ...(images ? { images: images.codec } : {}),
      progress,
      publish: (topic, reply) => publisher.publish(topic, reply),
    });
    const server = completionServer({
      adapter,
      authority: new ToolCompletionCapabilities(managementToken),
      key: await secret("PI_CLOUD_COMPLETION_TLS_KEY_FILE"),
      cert: await secret("PI_CLOUD_COMPLETION_TLS_CERT_FILE"),
      ready: async () => {
        await sql`select 1`.execute(database);
      },
    });
    cleanup.push(() => server.close());
    await server.listen({
      host: process.env.HOST ?? "0.0.0.0",
      port: Number(process.env.PORT ?? 4320),
    });
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    for (const close of cleanup.reverse()) await close().catch(() => {});
  }
}
void main().catch(() => {
  process.stderr.write("tool_completion_service_failed\n");
  process.exitCode = 1;
});
