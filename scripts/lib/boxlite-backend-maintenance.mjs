import { writeRuntimeFileAtomically } from "./runtime-file-policy.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase } from "../../packages/database/src/index.ts";
import { ResourceBackendRegistry } from "../../packages/sandbox-control/src/resource-backend-registry.ts";
import { verifyResourceBackend } from "../../packages/sandbox-control/src/resource-backend-transport.ts";
import { sql } from "kysely";

export const configurationIdentity = (configuration) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        ...configuration,
        templates: configuration.templates.map(({ imageRevision, ...value }) => value),
      }),
    )
    .digest("hex");

export function boxliteTemplatePublication(entry, current, imageRevision, nodeId) {
  assert(
    current &&
      current.configuration.compute.provider === "boxlite" &&
      current.configuration.compute.nodeId === nodeId,
    "Backend changed during native publication",
  );
  assert.equal(
    configurationIdentity(current.configuration),
    entry.configurationIdentity,
    "Backend configuration changed during native publication",
  );
  assert.equal(
    current.configuration.templates.length,
    1,
    "Coordinate custom BoxLite templates explicitly",
  );
  assert.equal(current.configuration.templates[0].id, "linux");
  const { id, name, location, state, computeBilling } = entry.resource;
  return {
    id,
    name,
    location,
    state,
    computeBilling,
    expectedRevision: entry.drainedRevision,
    configuration: {
      ...current.configuration,
      templates: current.configuration.templates.map((t) => ({ ...t, imageRevision })),
    },
  };
}

/** Operator verification resolves known local service names; stored URLs stay unchanged. */
export function boxliteVerificationConfiguration(configuration, resolveService) {
  const url = (value, name) => {
    const parsed = new URL(value);
    if (
      [name, `${name}.cube-system.svc`, `${name}.cube-system.svc.cluster.local`].includes(
        parsed.hostname,
      )
    )
      parsed.hostname = resolveService(name);
    return parsed.toString();
  };
  return {
    ...configuration,
    compute: { ...configuration.compute, url: url(configuration.compute.url, "pi-cloud-boxlite") },
    storage: {
      ...configuration.storage,
      url: url(configuration.storage.url, "workspace-volume-gateway"),
    },
  };
}

/** Stop new resource admission in PG before the native node can be replaced.
 * No VM is destroyed here and no unrelated backend is drained. */
export async function withBoxLiteBackendMaintenance(
  { runtimeDirectory, directory, nodeId, serviceAddress, kubectl },
  work,
) {
  const secret = async (name) =>
    (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim();
  const url = new URL(await secret("database-url"));
  url.hostname = serviceAddress("postgres");
  const database = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  const template = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/template.json"), "utf8"),
  );
  const base = {
    persistentStateKey: Buffer.from(await secret("cube-persistent-state-key"), "base64url"),
    serviceToken: await secret("sandbox-control-token"),
    imageRevision: template.imageRevision,
  };
  const registry = new ResourceBackendRegistry({
    database,
    key: base.persistentStateKey,
    managementBaseUrl: "http://control-plane:4300",
    verify: (value) =>
      verifyResourceBackend(
        database,
        base,
        boxliteVerificationConfiguration(value, (name) =>
          name === "pi-cloud-boxlite"
            ? JSON.parse(kubectl(["get", "service", name, "-o", "json"])).spec.clusterIP
            : serviceAddress(name),
        ),
      ),
  });
  const path = resolve(directory, "backend-maintenance.json");
  const save = (state) => writeRuntimeFileAtomically(path, JSON.stringify(state, null, 2) + "\n");
  let state;
  try {
    try {
      state = JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (!state || state.phase === "refused") {
      const matching = (await registry.list()).filter(
        (b) =>
          b.configuration.compute.provider === "boxlite" &&
          b.configuration.compute.nodeId === nodeId,
      );
      state = {
        nodeId,
        phase: "draining",
        backends: matching.map((b) => ({
          resource: b.resource,
          configurationIdentity: configurationIdentity(b.configuration),
          drainedRevision: null,
        })),
      };
      await save(state);
    }
    assert.equal(state.nodeId, nodeId, "Backend maintenance changed native identity");
    if (state.phase === "complete") return { alreadyApplied: true };
    const finish = async () => {
      for (const entry of state.backends) {
        const current = (await registry.list()).find((b) => b.resource.id === entry.resource.id);
        await registry.put(
          boxliteTemplatePublication(entry, current, template.imageRevision, nodeId),
        );
      }
      state.phase = "complete";
      await save(state);
    };
    if (state.phase === "applied") {
      await finish();
      return { applied: true };
    }
    for (const entry of state.backends) {
      if (!entry.drainedRevision) {
        const { id, name, location, state: previous, revision } = entry.resource;
        const next =
          previous === "active"
            ? await registry.put({
                id,
                name,
                location,
                state: "draining",
                expectedRevision: revision,
              })
            : entry.resource;
        entry.drainedRevision = next.revision;
        await save(state);
      }
      const current = (await registry.list()).find((b) => b.resource.id === entry.resource.id);
      assert(
        current &&
          current.resource.revision === entry.drainedRevision &&
          current.resource.state !== "active",
        "Backend admission changed during native maintenance",
      );
      const id = entry.resource.id;
      const used =
        await sql`select 1 from workspace_runtimes where sandbox_domain_id=${id} and state<>'released'
        union all select 1 from development_environments where sandbox_domain_id=${id} and (not allocation_absent or not allocation_closed)
        union all select 1 from workspace_terminal_sessions where sandbox_domain_id=${id} and state<>'released' limit 1`.execute(
          database,
        );
      assert.equal(
        used.rows.length,
        0,
        "Retire BoxLite allocations and unresolved admissions before replacing its node",
      );
    }
    state.phase = "applying";
    await save(state);
    await work();
    state.phase = "applied";
    await save(state);
    await finish();
    return { applied: true };
  } catch (error) {
    if (state?.phase === "draining") {
      const failures = [];
      for (const entry of state.backends)
        if (entry.drainedRevision && entry.resource.state === "active") {
          const { id, name, location } = entry.resource;
          try {
            await registry.put({
              id,
              name,
              location,
              expectedRevision: entry.drainedRevision,
              state: "active",
            });
          } catch (failure) {
            failures.push(failure);
          }
        }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "Native publication refused; some backend admission remains drained",
        );
      // Keep the refusal evidence, but a fresh retry must capture the restored revisions.
      state.phase = "refused";
      await save(state);
    }
    throw error;
  } finally {
    await database.destroy();
  }
}
