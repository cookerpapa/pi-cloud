import { writeRuntimeFileAtomically } from "./runtime-file-policy.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAllDocuments, stringify } from "yaml";
import {
  digest,
  manifestDigest,
  scopedHelmUpgradeArguments,
  assertServingComponents,
} from "./component-release.mjs";

/** Ignore only the top-level informational chart label. Pod templates, hooks,
 * selectors, runtime configuration and every other object field stay exact. */
export function assertMetadataOnlyManifests(before, after) {
  const normalized = (text) =>
    parseAllDocuments(text)
      .map((d) => {
        assert.equal(d.errors.length, 0);
        return d.toJSON();
      })
      .filter((r) => r && !r.metadata?.annotations?.["helm.sh/hook"])
      .map((r) => {
        const copy = structuredClone(r);
        if (copy.metadata?.labels) delete copy.metadata.labels["helm.sh/chart"];
        return copy;
      })
      .sort((a, b) => `${a.kind}/${a.metadata.name}`.localeCompare(`${b.kind}/${b.metadata.name}`));
  assert.deepEqual(
    normalized(after),
    normalized(before),
    "Metadata publication changed runtime objects or Pod templates",
  );
}
const save = (path, value) =>
  writeRuntimeFileAtomically(path, JSON.stringify(value, null, 2) + "\n");
export async function metadataRelease({
  action,
  directory,
  root,
  plan,
  baseline,
  capture,
  kubectl,
  kubeconfig,
  namespace,
  deploymentPath,
}) {
  const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
  const helmCall = (args) =>
    capture(helm, [...args, "--namespace", namespace, "--kubeconfig", kubeconfig]);
  const live = () => ({
    status: JSON.parse(helmCall(["status", "pi-cloud", "-o", "json"])),
    manifest: helmCall(["get", "manifest", "pi-cloud"]),
  });
  const chart = resolve(root, "deploy/helm/pi-cloud-platform");
  if (action === "prepare") {
    assert.equal(plan.mode, "metadata");
    await mkdir(directory, { mode: 0o700 });
    const current = live();
    assert.equal(current.status.info.status, "deployed");
    const values = JSON.parse(helmCall(["get", "values", "pi-cloud", "-o", "json"]));
    const valuesPath = resolve(directory, "values.yaml");
    await writeFile(valuesPath, stringify(values), { mode: 0o600 });
    const desired = helmCall(["template", "pi-cloud", chart, "--no-hooks", "--values", valuesPath]);
    assertMetadataOnlyManifests(current.manifest, desired);
    await writeFile(resolve(directory, "before.yaml"), current.manifest, { mode: 0o600 });
    await writeFile(resolve(directory, "rendered.yaml"), desired, { mode: 0o600 });
    await save(resolve(directory, "baseline.json"), baseline);
    await save(resolve(directory, "release-plan.json"), plan);
    await save(resolve(directory, "candidate.json"), {
      formatVersion: 2,
      mode: "metadata",
      revision: plan.revision,
      version: plan.version,
      baselineDigest: digest(baseline),
      releasePlanDigest: digest(plan),
      helmRevision: current.status.version,
      beforeDigest: digest(current.manifest),
      renderedDigest: digest(desired),
      valuesDigest: digest(await readFile(valuesPath, "utf8")),
    });
  }
  const candidate = JSON.parse(await readFile(resolve(directory, "candidate.json"), "utf8"));
  plan ??= JSON.parse(await readFile(resolve(directory, "release-plan.json"), "utf8"));
  baseline ??= JSON.parse(await readFile(resolve(directory, "baseline.json"), "utf8"));
  assert.equal(candidate.formatVersion, 2);
  assert.equal(candidate.mode, "metadata");
  assert.equal(digest(plan), candidate.releasePlanDigest);
  assert.equal(digest(baseline), candidate.baselineDigest);
  assert.equal(
    capture("git", ["status", "--porcelain", "--untracked-files=all"]).trim(),
    "",
    "Commit source before metadata publication",
  );
  assert.equal(
    capture("git", ["rev-parse", "HEAD"]).trim(),
    candidate.revision,
    "Prepare the metadata candidate from current source",
  );
  const before = await readFile(resolve(directory, "before.yaml"), "utf8");
  const desired = await readFile(resolve(directory, "rendered.yaml"), "utf8");
  assert.equal(digest(before), candidate.beforeDigest);
  assert.equal(digest(desired), candidate.renderedDigest);
  const valuesPath = resolve(directory, "values.yaml");
  assert.equal(digest(await readFile(valuesPath, "utf8")), candidate.valuesDigest);
  assert.equal(
    manifestDigest(helmCall(["template", "pi-cloud", chart, "--no-hooks", "--values", valuesPath])),
    manifestDigest(desired),
  );
  assertMetadataOnlyManifests(before, desired);
  const installed = JSON.parse(await readFile(deploymentPath, "utf8"));
  const next = {
    ...baseline,
    revision: candidate.revision,
    version: candidate.version,
    operatorRevision: candidate.revision,
    metadataPublication: { releasePlanDigest: candidate.releasePlanDigest },
  };
  delete next.releasePlanDigest;
  assert(
    [digest(baseline), digest(next)].includes(digest(installed)),
    "Another publication changed this candidate's baseline",
  );
  const workloads = () =>
    JSON.parse(kubectl(["get", "deployments,statefulsets,daemonsets", "-o", "json"])).items;
  assertServingComponents(installed, workloads());
  const current = live();
  assert.equal(
    current.status.info.status,
    "deployed",
    "Resolve the current Helm operation before metadata publication",
  );
  const applied = manifestDigest(current.manifest) === manifestDigest(desired);
  if (!applied) {
    assert.equal(current.status.version, candidate.helmRevision);
    assert.equal(manifestDigest(current.manifest), manifestDigest(before));
  }
  if (action !== "apply") return { mode: "metadata", ready: true, builds: 0, restarts: 0 };
  const pods = () =>
    JSON.parse(kubectl(["get", "pods", "-o", "json"]))
      .items.map((p) => p.metadata.uid)
      .sort();
  const initialPods = pods();
  if (!applied)
    capture(
      helm,
      scopedHelmUpgradeArguments({
        name: "pi-cloud",
        chart,
        values: valuesPath,
        kubeconfig,
        namespace,
      }),
      { timeout: 310_000 },
    );
  assert.equal(manifestDigest(live().manifest), manifestDigest(desired));
  assert.deepEqual(pods(), initialPods, "A Pod changed during metadata-only publication");
  assertServingComponents(next, workloads());
  await save(deploymentPath, next);
  await save(resolve(directory, "applied.json"), {
    revision: candidate.revision,
    builds: 0,
    restarts: 0,
    podUids: initialPods,
  });
  return { mode: "metadata", applied: true, builds: 0, restarts: 0 };
}
