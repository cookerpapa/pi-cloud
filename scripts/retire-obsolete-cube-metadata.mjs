import { nativeComputeRetirement } from "./lib/native-compute-retirement.mjs";
import { assertBoxLiteEmpty } from "./lib/boxlite-maintenance.mjs";
/** ADR-0311: explicit operator maintenance, never part of Tool execution. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, open, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  kubectl,
  runtimeDirectory,
  repositoryRoot,
  serviceAddress,
  workload,
} from "./lib/production-kubernetes.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
import { createComputeRetirementRepository } from "./lib/compute-retirement-postgres.mjs";
import {
  assertRetirementProcessesStopped,
  awaitComputeRetirementQuiescence,
  retireComputeForMaintenance,
} from "./lib/compute-retirement.mjs";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { CubePersistentCapsuleCodec } from "../packages/sandbox-control/src/cube-persistent-capsule.ts";
import { nativeCubeLifecycleOptions } from "./lib/cube-native-lifecycle-options.mjs";
import { stopNativeStorageConsumers } from "./lib/matched-workspace-storage.mjs";
import {
  templateLocatorRepair,
  templateInventoryQueries,
  parseMysqlRows,
} from "./lib/obsolete-cube-metadata.mjs";
import { waitForCubeNodeReadiness } from "./lib/cube-node-readiness.mjs";

const [directoryArg, binaryArg, ...selected] = process.argv.slice(2);
assert(
  directoryArg && binaryArg && selected.length,
  "Usage: retire-obsolete-cube-metadata.mjs EVIDENCE_DIRECTORY CLEANUP_BINARY TEMPLATE_ID...",
);
assert.equal(process.geteuid(), 0, "Cold node metadata maintenance requires host root");
serializeRelease(runtimeDirectory);
const directory = resolve(directoryArg),
  binary = resolve(binaryArg);
await mkdir(directory, { recursive: true, mode: 0o700 });
const record = resolve(directory, "obsolete-cube-maintenance.json");
async function save(value) {
  const file = await open(`${record}.next`, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(`${record}.next`, record);
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const cluster = await readJson(resolve(runtimeDirectory, "cubesandbox/cluster.json"));
const template = await readJson(resolve(runtimeDirectory, "cubesandbox/template.json"));
const protectedIds = [template.agent, ...Object.values(template.development)].map(
  (entry) => entry.templateId,
);
assert(
  selected.every((id) => !protectedIds.includes(id)),
  "Current templates are protected",
);
const mysql = (query) =>
  kubectl(
    [
      "exec",
      "-i",
      "cube-mysql-0",
      "--",
      "sh",
      "-eu",
      "-c",
      'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql --protocol=TCP --host=cube-mysql --user="$MYSQL_USER" --batch "$MYSQL_DATABASE"',
    ],
    { input: query, timeout: 30_000 },
  );
const inventory = () =>
  Object.fromEntries(
    Object.entries(templateInventoryQueries).map(([key, query]) => [
      key,
      parseMysqlRows(mysql(query)),
    ]),
  );
const directEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(all|https?|no)_proxy$/i.test(key)),
);
const cli = (args) =>
  execFileSync(
    resolve(runtimeDirectory, "cubesandbox/cubemastercli"),
    ["--address", cluster.master.host, "--port", String(cluster.master.port), ...args],
    { encoding: "utf8", env: directEnv, timeout: 45_000, maxBuffer: 8 * 1024 ** 2 },
  );
const absent = () => {
  const result = cli(["list", "--all", "--wide"]),
    nodes = /NODES_SCANNED\s+(\d+)\/(\d+)/.exec(result);
  assert(
    nodes && Number(nodes[1]) > 0 && nodes[1] === nodes[2] && /SANDBOX_COUNT\s+0\b/.test(result),
    "Native inventory must confirm no compute on every node",
  );
};
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const repository = createComputeRetirementRepository(database);
const services = [
  "web",
  "ssh-gateway",
  "pi-workers",
  "session-runtime",
  "session-api",
  "tool-completion",
  "tool-host",
  "control-plane",
  "workspace-volume-gateway",
  "metering",
  "workspace-quota",
];
let state;
try {
  state = await readJson(record);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const assertStopped = async () =>
  assertRetirementProcessesStopped({
    workloads: JSON.parse(kubectl(["get", "deployments,statefulsets", "-o", "json"])).items,
    pods: JSON.parse(kubectl(["get", "pods", "-o", "json"])).items,
  });
try {
  if (!state) {
    const { rows } =
      await sql`select count(*)::int as n from runs where state not in ('completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null)`.execute(
        database,
      );
    assert.equal(rows[0].n, 0, "Settle active Runs before cold maintenance");
    const current = inventory();
    templateLocatorRepair({ selected, protectedIds, ...current, nodeId: cluster.nodeName });
    state = {
      version: 1,
      selected,
      protectedIds,
      stage: "planned",
      resources: services.map((service) => {
        const object = JSON.parse(kubectl(["get", workload(service), "-o", "json"]));
        return {
          target: workload(service),
          uid: object.metadata.uid,
          replicas: object.spec.replicas,
          selector: Object.entries(object.spec.selector.matchLabels)
            .map(([k, v]) => `${k}=${v}`)
            .join(","),
        };
      }),
    };
    await save(state);
  }
  assert.equal(state.version, 1);
  assert.deepEqual(state.selected, selected);
  assert.deepEqual(state.protectedIds, protectedIds);
  if (state.stage === "completed") {
    console.log(JSON.stringify({ alreadyCompleted: true }));
    process.exitCode = 0;
  } else {
    if (["planned", "stopped"].includes(state.stage)) {
      for (const saved of state.resources) {
        const current = JSON.parse(kubectl(["get", saved.target, "-o", "json"]));
        assert.equal(current.metadata.uid, saved.uid, "Maintenance workload identity changed");
        kubectl(["scale", saved.target, "--replicas=0"]);
        if (JSON.parse(kubectl(["get", "pods", "-l", saved.selector, "-o", "json"])).items.length)
          kubectl(["wait", "--for=delete", "pod", "-l", saved.selector, "--timeout=120s"], {
            timeout: 125_000,
          });
      }
      await awaitComputeRetirementQuiescence({ repository, assertProcessesStopped: assertStopped });
      const { rows } =
        await sql`select (select count(*) from workspace_file_transfers where state='uploading')+(select count(*) from session_uploads where state='uploading') as n`.execute(
          database,
        );
      assert.equal(Number(rows[0].n), 0, "Settle uploads first");
      state.stage = "stopped";
      await save(state);
      const codec = new CubePersistentCapsuleCodec(
        Buffer.from(
          (
            await readFile(resolve(runtimeDirectory, "secrets/cube-persistent-state-key"), "utf8")
          ).trim(),
          "base64url",
        ),
      );
      const native = new OfficialCubeSandboxRuntimeClient({
        ...nativeCubeLifecycleOptions(),
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
      const retirement = nativeComputeRetirement({ cube: native, runtimeDirectory, kubectl });
      try {
        await retireComputeForMaintenance({
          repository,
          native: retirement,
          assertProcessesStopped: assertStopped,
          openCapsule: (v) => codec.open(v),
          progress: (v) => console.log(JSON.stringify(v)),
        });
      } finally {
        await retirement.close();
        await native.close();
      }
      absent();
      await assertBoxLiteEmpty({ kubectl });
      state.stage = "retired";
      await save(state);
    }
    if (state.stage === "retired") {
      await repository.assertDrained();
      await assertStopped();
      const restore = await stopNativeStorageConsumers({
        directory,
        kubectl,
        templateMaintenance: true,
      });
      // Native writer shutdown and OS bbolt exclusive lock are both required.
      assert(
        !JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.some((pod) =>
          pod.spec.containers.some((c) =>
            ["cubelet", "cube-master", "cube-templatecenter", "cube-api"].includes(c.name),
          ),
        ),
        "Native writer still exists",
      );
      const repair = templateLocatorRepair({
        selected,
        protectedIds,
        ...inventory(),
        nodeId: cluster.nodeName,
      });
      mysql(repair.sql);
      state.repairedLocators = (state.repairedLocators ?? 0) + repair.changed;
      state.node ??= {};
      for (const path of [
        "/data/cubelet/state/io.containerd.metadata.v1.bolt/meta.db",
        "/data/cubelet/state/io.cubelet.internal.v1.storage/db/volume_refcount.db",
      ]) {
        state.node[path] = JSON.parse(
          execFileSync(binary, ["--cold-prune", path], { encoding: "utf8", timeout: 15_000 }),
        );
      }
      await save(state);
      await restore();
      await waitForCubeNodeReadiness({ kubectl });
      state.stage = "deleting";
      await save(state);
    }
    if (state.stage === "deleting") {
      await repository.assertDrained();
      await assertStopped();
      absent();
      for (const id of selected) {
        if (inventory().templates.some((row) => row.template_id === id)) {
          cli(["tpl", "delete", "--template-id", id]);
          assert(
            !inventory().templates.some((row) => row.template_id === id),
            "Native template deletion is not settled",
          );
        }
      }
      const remaining = inventory();
      assert(
        protectedIds.every((id) =>
          remaining.templates.some((row) => row.template_id === id && row.status === "READY"),
        ),
        "Current template changed",
      );
      state.stage = "restoring";
      await save(state);
    }
    if (state.stage === "restoring") {
      for (const saved of state.resources) {
        const current = JSON.parse(kubectl(["get", saved.target, "-o", "json"]));
        assert.equal(current.metadata.uid, saved.uid);
        kubectl(["scale", saved.target, `--replicas=${saved.replicas}`]);
      }
      for (const saved of state.resources)
        kubectl(["rollout", "status", saved.target, "--timeout=300s"], { timeout: 305_000 });
      state.stage = "completed";
      await save(state);
      console.log(
        JSON.stringify({
          completed: true,
          templatesDeleted: selected.length,
          repairedLocators: state.repairedLocators,
          node: state.node,
        }),
      );
    }
  }
} finally {
  await database.destroy();
}
