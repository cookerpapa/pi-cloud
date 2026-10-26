import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "@pi-cloud/database/client";
import { KafkaToolReplyPublisher } from "@pi-cloud/event-log";
import { configuredImageAttachments, encodeSessionImages } from "@pi-cloud/session-attachments";
import { AppiumAndroidDriver } from "./appium-driver.ts";
import { AndroidExecutionManager } from "./execution-manager.ts";
import { createExecutorServer } from "./server.ts";

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error("Missing " + key);
  return value;
};
async function main() {
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    const database = createDatabase({
      connectionString: (await readFile(required("PI_CLOUD_DATABASE_URL_FILE"), "utf8")).trim(),
      maxConnections: 2,
    });
    cleanup.push(() => database.destroy());
    const images = await configuredImageAttachments(database);
    if (!images) throw new Error("Android observations require image attachment storage");
    cleanup.push(async () => images.blobs.close());
    const publisher = new KafkaToolReplyPublisher(
      required("PI_CLOUD_KAFKA_BROKERS").split(","),
      "android-executor-" + process.pid,
    );
    cleanup.push(() => publisher.close());
    await publisher.start();
    const driver = new AppiumAndroidDriver({
      url: required("PI_CLOUD_APPIUM_URL"),
      udid: required("PI_CLOUD_ANDROID_UDID"),
      systemPort: 8200,
    });
    cleanup.push(() => driver.close());
    await driver.open();
    const manager = new AndroidExecutionManager({
      targetId: required("PI_CLOUD_EXECUTION_TARGET_ID"),
      bootId: randomUUID(),
      ready: () => driver.ready,
      execute: (name, args, signal) => driver.execute(name, args, signal),
      pack: (binding, result, signal) =>
        encodeSessionImages(
          images.codec,
          { tenantId: binding.tenantId, runId: binding.runId },
          result,
          signal,
        ),
      publish: (topic, reply) => publisher.publish(topic, reply),
      onError: (code) => process.stderr.write(JSON.stringify({ event: code }) + "\n"),
    });
    cleanup.push(() => manager.close());
    const server = createExecutorServer({
      token: (await readFile(required("PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE"), "utf8")).trim(),
      manager,
      ready: () => driver.ready,
      screenshot: (signal) => driver.screenshot(signal),
    });
    cleanup.push(() => server.close());
    await server.listen({
      host: process.env.PI_CLOUD_EXECUTOR_HOST ?? "0.0.0.0",
      port: Number(process.env.PI_CLOUD_EXECUTOR_PORT ?? 8090),
    });
    process.stdout.write(
      JSON.stringify({
        event: "android_executor_ready",
        targetId: manager.options.targetId,
        bootId: manager.options.bootId,
      }) + "\n",
    );
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      // An Appium connection/device boot change requires a fresh admission boot.
      const timer = setInterval(() => {
        if (!driver.ready) {
          clearInterval(timer);
          resolve();
        }
      }, 1000);
      timer.unref();
      cleanup.push(async () => {
        clearInterval(timer);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      });
    });
  } finally {
    for (const close of cleanup.reverse()) await close().catch(() => {});
  }
}
void main().catch(() => {
  process.stderr.write("android_executor_failed\n");
  process.exitCode = 1;
});
