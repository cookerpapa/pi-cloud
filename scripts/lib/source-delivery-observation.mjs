import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import { kubectl, runtimeDirectory } from "./production-kubernetes.mjs";
import { sql } from "kysely";

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
export async function createDeployedSourceDeliveryReader({ database, tenantId }) {
  assert(database, "Accounting cursor database is required");
  assert(typeof tenantId === "string" && /^[0-9a-f-]{36}$/.test(tenantId), "Invalid receipt owner");
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
      kubectl(["get", "pods,services", "-o", "json"], { timeout: 10_000 }),
    );
    assert(Array.isArray(items), "Missing deployed receipt source inventory");
    const pods = items.filter((item) => item.kind === "Pod"),
      services = items.filter((item) => item.kind === "Service");
    const providerPod = onePod(pods, "cli-proxy-api"),
      quotaPod = onePod(pods, "workspace-quota"),
      meteringPod = onePod(pods, "metering");
    const {
      rows: [owned],
    } = await sql`select count(*)::int as resources,
      count(*) filter(where exists(select 1 from compute_service_periods p where p.resource_key=r.id and (p.ended_at is null or p.needs_settlement)))::int as pending
      from resource_metering_resources r where tenant_id=${tenantId}::uuid and kind='compute'`.execute(
      database,
    );
    // Source closure and final settlement share durable PG boundaries. A client
    // checks the committed pending state, not a fabricated provider cursor.
    const compute = [
      {
        sourceId: "platform-service-v1",
        podId: meteringPod.metadata.uid,
        epoch: "service-minute-v1",
        checkedAt: Date.now(),
        healthy: true,
        resources: owned.resources,
        pending: owned.pending,
      },
    ];
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
