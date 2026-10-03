import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Admin } from "@platformatic/kafka";

const execute = promisify(execFile);
const IMAGE =
  "apache/kafka@sha256:3f7b939115cd4872e9cee9369d80bd69712fde55f9902f46d793f64848dedc75";

/** Explicit test endpoints, or an isolated RF3 fixture with the production pin.
 * Docker is test scaffolding here; no production network or container is used. */
export async function testKafka(environment = process.env) {
  if (environment.PI_CLOUD_KAFKA_INTEGRATION_BROKERS) {
    const brokers = environment.PI_CLOUD_KAFKA_INTEGRATION_BROKERS.split(",").map((s) => s.trim());
    if (brokers.length !== 3 || brokers.some((b) => !/^[A-Za-z0-9._-]+:\d+$/.test(b)))
      throw new Error("Provide three explicit test Kafka host:port endpoints");
    return { brokers, async close() {} };
  }
  const name = `pi-cloud-test-kafka-${randomUUID()}`,
    containers = [];
  let network = false;
  const reserved = [];
  const close = async () => {
    const results = await Promise.allSettled(
      containers.map((id) =>
        execute("docker", ["stop", "--timeout=10", id], { timeout: 30000 }).catch((error) => {
          if (!/No such container/i.test(error.stderr ?? "")) throw error;
        }),
      ),
    );
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Test Kafka cleanup failed");
    containers.length = 0;
    if (network) {
      await execute("docker", ["network", "rm", name]);
      network = false;
    }
  };
  try {
    // Reserve loopback ports together so the three brokers cannot select the
    // same endpoint. Docker is the final authority if another process races us.
    for (let i = 0; i < 3; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      reserved.push(server);
    }
    const ports = reserved.map((s) => s.address().port);
    await execute("docker", ["network", "create", name]);
    network = true;
    await Promise.all(reserved.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    const peers = [1, 2, 3].map((i) => `${i}@${name}-${i}:9093`).join(",");
    const cluster = randomBytes(16).toString("base64url");
    const starts = await Promise.allSettled(
      [1, 2, 3].map(async (i) => {
        const id = `${name}-${i}`;
        const env = {
          CLUSTER_ID: cluster,
          KAFKA_NODE_ID: String(i),
          KAFKA_PROCESS_ROLES: "broker,controller",
          KAFKA_LISTENERS: "INTERNAL://:9092,EXTERNAL://:9094,CONTROLLER://:9093",
          KAFKA_ADVERTISED_LISTENERS: `INTERNAL://${id}:9092,EXTERNAL://127.0.0.1:${ports[i - 1]}`,
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
            "INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT",
          KAFKA_INTER_BROKER_LISTENER_NAME: "INTERNAL",
          KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
          KAFKA_CONTROLLER_QUORUM_VOTERS: peers,
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "3",
          KAFKA_OFFSETS_TOPIC_NUM_PARTITIONS: "32",
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "3",
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "2",
          KAFKA_DEFAULT_REPLICATION_FACTOR: "3",
          KAFKA_MIN_INSYNC_REPLICAS: "2",
          KAFKA_HEAP_OPTS: "-Xms128m -Xmx256m",
        };
        await execute(
          "docker",
          [
            "run",
            "--detach",
            "--rm",
            "--name",
            id,
            "--network",
            name,
            "--memory=768m",
            "--cpus=1",
            "--publish",
            `127.0.0.1:${ports[i - 1]}:9094`,
            ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
            IMAGE,
          ],
          { timeout: 300000 },
        );
        containers.push(id);
      }),
    );
    for (const result of starts) if (result.status === "rejected") throw result.reason;
    const brokers = ports.map((port) => `127.0.0.1:${port}`);
    const admin = new Admin({ bootstrapBrokers: brokers, clientId: name, autocreateTopics: false });
    try {
      const deadline = performance.now() + 60000;
      for (;;) {
        try {
          await admin.listTopics();
          break;
        } catch {
          if (performance.now() >= deadline) throw new Error("Test Kafka did not become ready");
        }
        await delay(250);
      }
    } finally {
      await admin.close();
    }
    return { brokers, close };
  } catch (error) {
    await Promise.all(reserved.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
    await close();
    throw error;
  }
}
