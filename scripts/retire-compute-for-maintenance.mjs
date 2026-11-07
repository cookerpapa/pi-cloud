import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { CubePersistentCapsuleCodec } from "../packages/sandbox-control/src/cube-persistent-capsule.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { runtimeDirectory, kubectl, serviceAddress } from "./lib/production-kubernetes.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import { createComputeRetirementRepository } from "./lib/compute-retirement-postgres.mjs";
import {
  assertRetirementProcessesStopped,
  awaitComputeRetirementQuiescence,
  retireComputeForMaintenance,
  validateRetirementTarget,
} from "./lib/compute-retirement.mjs";

const [action, domainId, extra] = process.argv.slice(2);
if (action === "--help") {
  console.log(
    "Usage: node --import tsx scripts/retire-compute-for-maintenance.mjs inspect|apply DOMAIN\nApply requires already-drained Runs/writers/terminals, stopped application processes and expired owner leases. It closes compute only and preserves Workspaces/machine intent. See ADR-0304.",
  );
  process.exit(0);
}
assert(
  ["inspect", "apply"].includes(action) && domainId && !extra,
  "Provide inspect|apply and the exact Sandbox domain",
);
if (action === "apply") serializeRelease(runtimeDirectory);
const abort = new AbortController();
const interrupted = () =>
  abort.abort(new Error("Compute retirement interrupted; recorded cleanup targets are retained"));
process.on("SIGTERM", interrupted);
process.on("SIGINT", interrupted);
let database, native;
try {
  const endpoint = new URL(
    (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
  );
  endpoint.hostname = serviceAddress("postgres");
  database = createDatabase({
    connectionString: endpoint.toString(),
    maxConnections: 2,
    checkoutTimeoutMs: 10_000,
  });
  const repository = createComputeRetirementRepository(database);
  const list = repository.listTargets;
  repository.listTargets = async () => {
    const targets = await list();
    assert(
      targets.every((target) => target.domainId === domainId),
      "Inventory spans a different Sandbox domain; refuse partial native retirement",
    );
    return targets;
  };
  const encodedKey = (
    await readFile(resolve(runtimeDirectory, "secrets/cube-persistent-state-key"), "utf8")
  ).trim();
  const key = Buffer.from(encodedKey, "base64url");
  assert(encodedKey.length === 43 && key.length === 32, "Invalid recorded capsule key");
  const codec = new CubePersistentCapsuleCodec(key);
  const openCapsule = (capsule) => codec.open(capsule);
  if (action === "inspect") {
    const targets = (await repository.listTargets()).map((target) =>
      validateRetirementTarget(target, openCapsule),
    );
    console.log(
      JSON.stringify({
        action,
        domainId,
        targets: targets.map((target) => ({
          kind: target.kind,
          id: target.id,
          allocationId: target.allocationId,
          workspaceId: target.workspaceId,
          state: target.state,
          ...(target.desiredState ? { desiredState: target.desiredState } : {}),
          neverIssued: target.neverIssued,
          recordedNode: target.nodeId,
        })),
      }),
    );
  } else {
    const cluster = JSON.parse(
      await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
    );
    native = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
      apiKey: (
        await readFile(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), "utf8")
      ).trim(),
      proxyNodeIp: cluster.proxy.host,
      proxyPort: cluster.proxy.port,
      proxyScheme: "http",
      sandboxDomain: cluster.sandboxDomain,
      egressProxyIp: "10.255.255.254",
    });
    const assertProcessesStopped = async () =>
      assertRetirementProcessesStopped({
        workloads: JSON.parse(
          kubectl(["get", "deployments,statefulsets", "-o", "json"], { timeout: 15_000 }),
        ).items,
        pods: JSON.parse(kubectl(["get", "pods", "-o", "json"], { timeout: 15_000 })).items,
      });
    await awaitComputeRetirementQuiescence({
      repository,
      assertProcessesStopped,
      signal: abort.signal,
    });
    const completed = await retireComputeForMaintenance({
      repository,
      native,
      openCapsule,
      signal: abort.signal,
      assertProcessesStopped,
      progress: (value) => console.log(JSON.stringify(value)),
    });
    console.log(
      JSON.stringify({ action, domainId, retired: completed.length, workspacesPreserved: true }),
    );
  }
} catch (error) {
  // Never print raw request/row objects: reconnect capsules contain credentials.
  process.stderr.write(`${error instanceof Error ? error.message : "Compute retirement failed"}\n`);
  process.exitCode = 1;
} finally {
  process.removeListener("SIGTERM", interrupted);
  process.removeListener("SIGINT", interrupted);
  await native?.close();
  await database?.destroy();
}
