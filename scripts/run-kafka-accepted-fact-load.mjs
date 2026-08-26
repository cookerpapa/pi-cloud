import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const image =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";

const output = await new Promise((resolvePromise, rejectPromise) => {
  execFile(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "pi-cloud-production_event-log",
      "--volume",
      `${repositoryRoot}:/app:ro`,
      "--workdir",
      "/app",
      image,
      "node",
      "--import",
      "tsx",
      "scripts/kafka-accepted-fact-load-worker.mjs",
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024, timeout: 10 * 60_000 },
    (error, stdout, stderr) => {
      if (error) rejectPromise(new Error(stderr.trim() || error.message));
      else resolvePromise(stdout.trim());
    },
  );
});

const report = JSON.parse(output.split("\n").at(-1));
const reportDirectory = resolve(repositoryRoot, "docs/reports");
await mkdir(reportDirectory, { recursive: true });
await writeFile(
  resolve(reportDirectory, "kafka-accepted-fact-load-latest.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
await writeFile(
  resolve(reportDirectory, "kafka-accepted-fact-load-latest.md"),
  [
    "# Kafka AcceptedFact load",
    "",
    `- Checked at: ${report.generatedAt}`,
    `- Kafka: ${String(report.kafka.brokers)} brokers / ${String(report.kafka.partitions)} partitions / RF ${String(report.kafka.replicas)} / acks=${report.kafka.acknowledgements}`,
    `- Application microbatch: ${String(report.applicationMicrobatch)}`,
    "",
    "| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.cases.map(
      (item) =>
        `| ${item.name} | ${String(item.events)} | ${String(item.eventsPerSecond)} | ${String(item.acknowledgementLatencyMs.p50)} ms | ${String(item.acknowledgementLatencyMs.p95)} ms | ${String(item.acknowledgementLatencyMs.p99)} ms |`,
    ),
    "",
  ].join("\n"),
);
process.stdout.write(`${JSON.stringify(report)}\n`);
