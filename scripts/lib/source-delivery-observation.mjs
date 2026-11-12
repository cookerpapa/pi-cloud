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

export function lifecycleProviderId(pod) {
  const domain = pod.spec?.containers
    ?.find((container) => container.name === "metering")
    ?.env?.find((entry) => entry.name === "PI_CLOUD_SANDBOX_DOMAIN_ID")?.value;
  assert(
    typeof domain === "string" && domain.length > 0,
    "Metering source identity is unavailable",
  );
  return `cubesandbox:${domain}`;
}

/** BoxLite compute is registered but currently has no observation producer.
 * Only a positively purged owned test Workspace can retire those unpriced
 * registrations. A newly installed collector must join the delivery inventory. */
export function assertUncollectedComputeClosed({
  sourceId,
  registeredBoxliteBackend,
  workspacePurged,
  collectorExists,
}) {
  assert(
    typeof sourceId === "string" &&
      /^boxlite:[A-Za-z0-9_.-]{1,64}$/.test(sourceId) &&
      registeredBoxliteBackend === true,
    "Unknown compute receipt producer",
  );
  assert(!collectorExists, "BoxLite collector must join the receipt delivery inventory");
  assert(workspacePurged, "Uncollected compute still has an unconfirmed Workspace closure");
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
    const provider = lifecycleProviderId(meteringPod);
    const cursor = await database
      .selectFrom("resource_lifecycle_sources")
      .select(["epoch", "checked_at", "failed_at"])
      .where("provider", "=", provider)
      .where("node_id", "=", "observations")
      .executeTakeFirst();
    const {
      rows: [owned],
    } = await sql`select count(*)::int as resources,
      count(*) filter(where lifecycle_state->'event'->>'state' is distinct from 'absent')::int as pending
      from resource_metering_resources where tenant_id=${tenantId}::uuid and kind='compute'
      and provider_binding->>'sourceId'=${provider}`.execute(database);
    const { rows: uncollected } = await sql`
      select r.provider_binding->>'sourceId' as source_id,
        bool_and(w.storage_purged_at is not null) as workspace_purged,
        bool_and(exists(select 1 from sandbox_domains d
          where d.backend_catalog->>'provider'='boxlite'
            and 'boxlite:'||d.id=r.provider_binding->>'sourceId')) as registered_boxlite_backend,
        bool_or(exists(select 1 from resource_lifecycle_sources s
          where s.provider=r.provider_binding->>'sourceId')) as collector_exists
      from resource_metering_resources r left join workspaces w
        on w.id=r.workspace_id and w.tenant_id=r.tenant_id
      where r.tenant_id=${tenantId}::uuid and r.kind='compute'
        and (r.provider_binding->>'sourceId') is distinct from ${provider}
      group by r.provider_binding->>'sourceId'`.execute(database);
    for (const row of uncollected)
      assertUncollectedComputeClosed({
        sourceId: row.source_id,
        registeredBoxliteBackend: row.registered_boxlite_backend,
        workspacePurged: row.workspace_purged === true,
        collectorExists: row.collector_exists,
      });
    // Stock observations and derived receipts commit in one PG transaction.
    // Once an owned resource is absent, future pages exclude it; stale pages
    // cannot pass the collector's cursor CAS. No Cubelet journal remains to drain.
    const compute = [
      {
        sourceId: `${provider}:observations`,
        podId: meteringPod.metadata.uid,
        epoch: cursor?.epoch ?? "uninitialized",
        checkedAt: cursor?.checked_at ? new Date(cursor.checked_at).getTime() : 0,
        healthy: Boolean(
          cursor?.epoch &&
          cursor.checked_at &&
          !cursor.failed_at &&
          Date.now() - new Date(cursor.checked_at).getTime() <= 180000,
        ),
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
