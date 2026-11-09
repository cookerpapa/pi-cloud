import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import { kubectl, runtimeDirectory } from "./production-kubernetes.mjs";
import { CubeLifecycleSource } from "../../packages/accounting/src/cube-lifecycle-source.ts";
import { parseComputeCaptureMetrics } from "./source-delivery-barrier.mjs";

const dispatcher = new Agent();
const hasContainer = (pod, name) =>
  pod.spec?.containers?.some((container) => container.name === name);
function ready(pod) {
  assert(
    pod?.metadata?.uid &&
      !pod.metadata.deletionTimestamp &&
      pod.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
    "A receipt source Pod is not Ready",
  );
  return pod;
}
function onePod(pods, container) {
  const found = pods.filter((pod) => hasContainer(pod, container));
  assert.equal(found.length, 1, "Receipt source Pod inventory is incomplete or overlapping");
  return ready(found[0]);
}
function endpoint(address, port, path) {
  assert(
    isIP(address) && Number.isSafeInteger(port) && port > 0 && port <= 65535,
    "Invalid receipt source address",
  );
  return `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}${path}`;
}
function serviceURL(services, name, portName, path) {
  const found = services.filter((service) => service.metadata.name === name);
  assert.equal(found.length, 1, "Receipt source Service is missing");
  const service = found[0],
    port = service.spec?.ports?.find((value) => value.name === portName)?.port;
  return endpoint(service.spec?.clusterIP, port, path);
}
async function boundedRead(url, token, maximum, signal) {
  const response = await fetch(url, {
    dispatcher,
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Source delivery observation unavailable (${response.status})`);
  }
  const reader = response.body?.getReader();
  assert(reader, "Missing source delivery response");
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert(size <= maximum, "Source delivery response exceeds its bound");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Operator-only private reader. Kubernetes is used only to discover existing
 * source Pods/Services. Source calls only read metrics/history and the accounting cursor; no lifecycle mutation. */
export async function createDeployedSourceDeliveryReader({ database }) {
  assert(database, "Accounting cursor database is required");
  const cluster = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const source = new CubeLifecycleSource({
    id: `cube:${cluster.sandboxDomain}`,
    url: `http://${cluster.api.host}:${cluster.api.port}`,
    apiKey: (
      await readFile(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), "utf8")
    ).trim(),
  });
  const [receiptToken, quotaToken] = await Promise.all([
    readFile(resolve(runtimeDirectory, "secrets/metering-ingest-token"), "utf8"),
    readFile(resolve(runtimeDirectory, "secrets/workspace-volume-gateway-token"), "utf8"),
  ]);
  assert(
    receiptToken.trim() && quotaToken.trim(),
    "Source observation credentials are unavailable",
  );
  return async (signal) => {
    signal?.throwIfAborted();
    const { items } = JSON.parse(
      kubectl(["get", "pods,daemonsets,services", "-o", "json"], { timeout: 10_000 }),
    );
    assert(Array.isArray(items), "Missing deployed receipt source inventory");
    const pods = items.filter((item) => item.kind === "Pod"),
      services = items.filter((item) => item.kind === "Service"),
      nodes = items.filter(
        (item) => item.kind === "DaemonSet" && hasContainer(item.spec?.template, "cubelet"),
      );
    assert(nodes.length > 0, "Cube receipt source DaemonSet is missing");
    let expected = 0;
    for (const node of nodes) {
      const desired = node.status?.desiredNumberScheduled;
      assert(
        Number.isSafeInteger(desired) && desired > 0 && node.status.numberReady === desired,
        "Not all recorded Cube source nodes are Ready",
      );
      expected += desired;
    }
    const cubePods = pods.filter((pod) => hasContainer(pod, "cubelet"));
    assert(
      cubePods.length === expected && expected <= 256,
      "Cube receipt source node coverage is incomplete",
    );
    const providerPod = onePod(pods, "cli-proxy-api"),
      quotaPod = onePod(pods, "workspace-quota");
    const captures = await Promise.all(
      cubePods.map(async (pod) => {
        ready(pod);
        assert(
          nodes.some((node) =>
            pod.metadata.ownerReferences?.some((owner) => owner.uid === node.metadata.uid),
          ),
          "Cube source Pod has an unrecognized owner",
        );
        const port = pod.spec.containers
          .find((container) => container.name === "cubelet")
          .ports?.find((value) => value.name === "cubelet-http")?.containerPort;
        const text = await boundedRead(
          endpoint(pod.status.podIP, port, "/v1/metrics"),
          null,
          1_048_576,
          signal,
        );
        return parseComputeCaptureMetrics(text, pod.metadata.uid);
      }),
    );
    const lifecycleNodes = await source.list(signal ?? AbortSignal.timeout(28000));
    assert.equal(lifecycleNodes.length, captures.length, "Lifecycle source coverage changed");
    const compute = [];
    for (const node of lifecycleNodes) {
      assert(node.available, "Lifecycle source is unavailable");
      // Metrics precede the raw head read; the latter covers all completed
      // captures reported in that scrape, including a final absent observation.
      const page = await source.read(node.id, undefined, signal ?? AbortSignal.timeout(28000));
      const matching = captures.filter((capture) => capture.sourceId === page.epoch);
      assert.equal(matching.length, 1, "Lifecycle epoch cannot be mapped to a Ready node");
      const capture = matching[0];
      const cursor = await database
        .selectFrom("resource_lifecycle_sources")
        .select(["epoch", "after_sequence", "failed_at"])
        .where("node_id", "=", node.id)
        .where("provider", "=", source.id)
        .executeTakeFirst();
      compute.push({
        ...capture,
        sourceId: node.id,
        deliveredCycles:
          cursor &&
          !cursor.failed_at &&
          cursor.epoch === page.epoch &&
          BigInt(cursor.after_sequence) >= BigInt(page.high)
            ? capture.completedCycles
            : null,
      });
    }
    const [quotaText, providerText] = await Promise.all([
      boundedRead(
        serviceURL(services, "workspace-quota", "quota", "/v1/delivery"),
        quotaToken.trim(),
        8192,
        signal,
      ),
      boundedRead(
        serviceURL(services, "cli-proxy-api", "http", "/internal/picloud/metering/delivery"),
        receiptToken.trim(),
        8192,
        signal,
      ),
    ]);
    return {
      compute,
      quota: { ...JSON.parse(quotaText), podId: quotaPod.metadata.uid },
      provider: { ...JSON.parse(providerText), podId: providerPod.metadata.uid },
    };
  };
}
