// Owned financial fixture: a real Luna receipt survives receiver downtime and
// provider replacement. No user conversation, Workspace or model tariff changes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ModelMeteringService } from "@pi-cloud/accounting";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
  kubectlAsync,
  workload,
} from "./lib/production-kubernetes.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_MODEL_METERING_CHECK,
  "1",
  "Authorize the owned Luna metering/restart fixture",
);
const output = resolve(
  process.argv[2] ?? "deploy/production/runtime/diagnostics/model-metering.json",
);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const endpoint = new URL(
  (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const key = (await readFile(`${runtimeDirectory}/secrets/cli-proxy-api-key`, "utf8")).trim();
const meteringKey = (
  await readFile(`${runtimeDirectory}/secrets/metering-ingest-token`, "utf8")
).trim();
const origin = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const report = { at: new Date().toISOString(), accepted: false, cleanupConfirmed: false };
let tenant,
  stopped = false,
  receiverStopped = false,
  failure;
async function until(read, label, budget = 120_000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(500);
  }
  throw Error(`${label} timed out`);
}
async function restoreReceiver() {
  if (!receiverStopped) return;
  await kubectlAsync(["scale", workload("metering"), "--replicas=1"]);
  await kubectlAsync(["rollout", "status", workload("metering"), "--timeout=180s"]);
  // Pod readiness can precede the host's ClusterIP route update after replacement.
  const receiverUrl = `http://${serviceAddress("metering")}:3000`;
  await until(
    async () => {
      try {
        const response = await fetch(`${receiverUrl}/health/ready`, {
          signal: AbortSignal.timeout(3000),
        });
        await response.body?.cancel();
        return response.status === 200;
      } catch {
        return false;
      }
    },
    "Receiver host route after restart",
    30_000,
  );
  receiverStopped = false;
}
async function restore() {
  await restoreReceiver();
  if (!stopped) return;
  await kubectlAsync(["scale", workload("control-plane"), "--replicas=1"]);
  await kubectlAsync(["rollout", "status", workload("control-plane"), "--timeout=180s"]);
  stopped = false;
}
try {
  const active = await db
    .selectFrom("runs")
    .select("id")
    .where("state", "not in", ["completed", "failed", "cancelled", "timed_out"])
    .execute();
  assert.equal(active.length, 0, "Active user work prevents receiver downtime acceptance");
  await until(
    async () =>
      !(
        await db
          .selectFrom("session_leases")
          .select("lease_id")
          .where("released_at", "is", null)
          .execute()
      ).length,
    "Writer settlement",
  );
  const cp = JSON.parse(kubectl(["get", workload("control-plane"), "-o", "json"]));
  assert.equal(cp.spec.replicas, 1, "Expected one active Control Plane");
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-metering-${randomUUID()}`,
    ownerDisplayName: "Model metering acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  const context = {
    version: 1,
    invocationId: randomUUID(),
    tenantId: tenant.tenantId,
    sessionId: randomUUID(),
    runId: randomUUID(),
    requestedAt: new Date().toISOString(),
    provider: "openai-codex",
    model: "gpt-6-luna",
    purpose: "agent",
  };
  report.invocationId = context.invocationId;
  const service = new ModelMeteringService(db),
    effective = new Date(Date.now() + 2000).toISOString();
  for (const serviceTier of ["default", "auto", "standard", "priority"]) {
    await service.createRate(tenant.tenantId, {
      kind: "customer",
      provider: "openai-codex",
      model: "gpt-6-luna",
      serviceTier,
      effectiveAt: effective,
      currency: "USD",
      includeFailed: false,
      perMillion: { input: "1", cacheRead: "0.1", cacheWrite: "1", output: "5", reasoning: "5" },
    });
  }
  const selector = Object.entries(cp.spec.selector.matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  stopped = true;
  await kubectlAsync(["scale", workload("control-plane"), "--replicas=0"]);
  await kubectlAsync(["wait", "--for=delete", "pod", "-l", selector, "--timeout=180s"]);
  await until(() => Date.now() >= Date.parse(effective), "Fixture price activation", 5000);
  context.requestedAt = new Date().toISOString();
  assert(Date.parse(context.requestedAt) >= Date.parse(effective));
  const request = async () => {
    const response = await fetch(`http://${serviceAddress("cli-proxy-api")}:8317/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-picloud-metering": Buffer.from(JSON.stringify(context)).toString("base64url"),
      },
      body: JSON.stringify({
        model: "gpt-6-luna",
        stream: true,
        store: false,
        instructions: "Be concise.",
        input: [{ role: "user", content: "Reply with METER_OK only." }],
        reasoning: { effort: "low" },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.equal(response.status, 200, "Luna request failed");
    assert.match(await response.text(), /"response.completed"/, "Missing native completion");
  };
  await request();
  await until(async () => {
    const p = await service.list(tenant.tenantId, {
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      limit: 50,
    });
    return (
      p.items.find((item) => item.context.invocationId === context.invocationId)?.state ===
      "confirmed"
    );
  }, "Receipts while management is stopped");
  report.managementIndependentIngestion = { invocationId: context.invocationId, confirmed: true };
  const receiver = JSON.parse(kubectl(["get", workload("metering"), "-o", "json"]));
  assert.equal(receiver.spec.replicas, 1, "Expected one receiver for the outage fixture");
  const receiverSelector = Object.entries(receiver.spec.selector.matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  receiverStopped = true;
  await kubectlAsync(["scale", workload("metering"), "--replicas=0"]);
  await kubectlAsync(["wait", "--for=delete", "pod", "-l", receiverSelector, "--timeout=180s"]);
  context.invocationId = randomUUID();
  context.requestedAt = new Date().toISOString();
  report.invocationId = context.invocationId;
  await request();
  const before = await db
    .selectFrom("model_invocations")
    .select("id")
    .where("id", "=", context.invocationId)
    .execute();
  assert.equal(before.length, 0, "Receiver was not offline");
  const providerPod = JSON.parse(
    kubectl(["get", "pods", "-l", "app.kubernetes.io/component=cli-proxy-api", "-o", "json"]),
  ).items;
  assert.equal(providerPod.length, 1);
  await kubectlAsync([
    "delete",
    "pod",
    providerPod[0].metadata.name,
    "--wait=true",
    "--timeout=120s",
  ]);
  await kubectlAsync(["rollout", "status", "statefulset/cli-proxy-api", "--timeout=180s"]);
  report.providerReplacedWhileReceiverOffline = true;
  await restoreReceiver();
  const page = await until(async () => {
    const p = await service.list(tenant.tenantId, {
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      limit: 50,
    });
    return p.items[0]?.state === "confirmed" && p;
  }, "Durable receipt delivery");
  const receipts = await db
    .selectFrom("model_metering_events")
    .select("payload")
    .where("invocation_id", "=", context.invocationId)
    .execute();
  report.observedUsage = page.items[0].usage.map((e) => ({
    executionId: e.executionId,
    model: e.usage.model,
    serviceTier: e.usage.serviceTier,
    quality: e.usage.quality,
    unsupportedDimensions: e.usage.unsupportedDimensions,
    tokens: e.usage.tokens,
    valuation: e.valuation,
  }));
  assert(page.items[0].usage.length > 0);
  assert(
    page.items[0].usage.some((u) => u.valuation.customer.state === "priced"),
    "Fixture rate did not produce a priced receipt",
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    const ack = await fetch(
      `http://${serviceAddress("metering")}:3000/internal/v1/model-metering`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${meteringKey}`, "content-type": "application/json" },
        body: JSON.stringify({ events: receipts.map((r) => r.payload) }),
        signal: AbortSignal.timeout(15000),
      },
    );
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).accepted, receipts.length);
  }
  assert.equal(
    (
      await db
        .selectFrom("model_metering_events")
        .select("id")
        .where("invocation_id", "=", context.invocationId)
        .execute()
    ).length,
    receipts.length,
  );
  await restore();
  const api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), origin), init),
    tenant.credential.token,
  );
  const published = await api.modelBilling(new URLSearchParams());
  assert.equal(published.items[0].context.invocationId, context.invocationId);
  const exported = await fetch(`${origin}/v1/model-billing/export`, {
    headers: { authorization: `Bearer ${tenant.credential.token}` },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(exported.status, 200);
  const exportedItems = (await exported.text())
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const invocationId of [
    context.invocationId,
    report.managementIndependentIngestion.invocationId,
  ])
    assert(
      exportedItems.some((item) => item.context.invocationId === invocationId),
      "NDJSON export omitted an observed model invocation",
    );
  await withChromePage({}, async (browser) => {
    await browser.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
    });
    await browser.navigate(origin);
    await browser.waitFor("document.querySelector('.product-account-menu-trigger')");
    await browser.evaluate("document.querySelector('.product-account-menu-trigger').click()");
    await browser.evaluate(
      "[...document.querySelectorAll('button')].find(b=>['Usage and costs','用量与费用'].includes(b.textContent.trim())).click()",
    );
    await browser.waitFor("document.querySelector('.product-billing-table tbody tr')");
    await browser.screenshot(output + ".png");
  });
  report.receipts = receipts.length;
  report.usage = page.items[0].usage.map((e) => ({
    executionId: e.executionId,
    tokens: e.usage.tokens,
    quality: e.usage.quality,
    valuation: e.valuation,
  }));
  report.publicQueryAndExport = true;
  report.duplicateDeliveries = 2;
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 500);
} finally {
  try {
    await restore();
    if (tenant) {
      const blobs = new S3AttachmentBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
        ),
      });
      try {
        await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    failure ??= error;
    report.cleanupFailure = String(error?.message ?? error).slice(0, 500);
  }
  await db.destroy();
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
console.log(
  JSON.stringify({ accepted: report.accepted, cleanupConfirmed: report.cleanupConfirmed, output }),
);
if (failure) throw failure;
