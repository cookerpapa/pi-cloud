import { parse } from "yaml";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { dockerSourceInputs } from "./component-release.mjs";
import { releaseImpact, imageReleaseTargets } from "./release-impact.mjs";
import { guestBuildIdentityAtRevision } from "./guest-build-identity.mjs";

export const applicationArtifacts = Object.freeze([
  {
    name: "control-plane",
    key: "controlPlane",
    dockerfile: "packages/control-plane/Dockerfile",
    roles: [
      "controlPlane",
      "sessionRuntime",
      "sessionApi",
      "toolCompletion",
      "metering",
      "toolHost",
    ],
  },
  {
    name: "supervisor-host",
    key: "worker",
    dockerfile: "packages/supervisor-host/Dockerfile",
    roles: ["worker"],
  },
  {
    name: "workspace-volume-gateway",
    key: "volumeGateway",
    dockerfile: "packages/sandbox-control/Dockerfile.volume-gateway",
    roles: ["volumeGateway"],
  },
  { name: "web-ui", key: "web", dockerfile: "packages/web-ui/Dockerfile", roles: ["web"] },
  {
    name: "provider-egress-relay",
    key: "relay",
    dockerfile: "packages/provider-egress-relay/Dockerfile",
    roles: ["relay"],
  },
  {
    name: "ssh-gateway",
    key: "sshGateway",
    dockerfile: "packages/ssh-gateway/Dockerfile",
    roles: ["sshGateway"],
  },
  {
    name: "cli-proxy-api",
    key: "provider",
    dockerfile: "deploy/provider-gateway/Dockerfile",
    roles: ["provider"],
  },
  {
    name: "cube-api-authorizer",
    dockerfile: "packages/cube-api-authorizer/Dockerfile",
    roles: ["cubeAuthorizer"],
  },
  {
    name: "cube-egress-gateway",
    dockerfile: "packages/cube-egress-gateway/Dockerfile",
    roles: ["cubeEgress"],
  },
]);
export const nativeArtifactNames = ["cube-api", "cube-master", "cube-templatecenter", "cubelet"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const execute = promisify(execFile);
const snapshots = new Map();
async function git(root, args) {
  return (
    await execute("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 ** 2, timeout: 30_000 })
  ).stdout;
}
async function tree(root, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  const key = `${root}:${revision}`;
  if (!snapshots.has(key))
    snapshots.set(
      key,
      (async () => {
        const entries = (await git(root, ["ls-tree", "-rz", "--full-tree", revision]))
          .split("\0")
          .filter(Boolean);
        return new Map(
          entries.map((entry) => {
            const split = entry.indexOf("\t"),
              [mode, type, object] = entry.slice(0, split).split(" ");
            assert(type === "blob", "Release inputs cannot silently follow a submodule");
            return [entry.slice(split + 1), { mode, object }];
          }),
        );
      })(),
    );
  return snapshots.get(key);
}

/** Git-declared bytes/modes, including the actual Dockerfile COPY closure.
 * OCI IDs and scan evidence remain separate: equal source is not a fresh build. */
export async function artifactInputIdentity(root, revision, dockerfile) {
  const files = await tree(root, revision);
  const content = await git(root, ["show", `${revision}:${dockerfile}`]);
  const inputs = dockerSourceInputs(dockerfile, [...files.keys()], content);
  const entries = inputs.map((path) => {
    const entry = files.get(path);
    assert(entry, `Missing declared artifact input ${path}`);
    return { path, ...entry };
  });
  return { identity: hash({ format: 1, entries }), files: inputs };
}

export function physicalMaintenance(files) {
  const storage = files.filter(
    (file) =>
      /^deploy\/(?:workspace-quota|file-exchange)\//.test(file) ||
      file === "deploy/cubesandbox/cube-volume-picloud-posix.sh" ||
      /^packages\/sandbox-control\/src\/(?:workspace-persistence|postgres-workspace-persistence|persistent-volume-workspace-volume-gateway|workspace-volume-gateway-contract|filesystem-workspace-volume-gateway-lock)\.ts$/.test(
        file,
      ),
  );
  const native = files.filter(
    (file) =>
      file.startsWith("deploy/cubesandbox/") ||
      file.startsWith("deploy/boxlite/") ||
      /^scripts\/(?:render-cube-release|reconcile-cubesandbox-release)\.mjs$/.test(file) ||
      /^scripts\/lib\/cube-release-(?:inputs|policy|render)\.mjs$/.test(file) ||
      file === "scripts/lib/deployment-backend-templates.mjs" ||
      /^packages\/sandbox-control\/src\/(?:fixed-guest-sandbox-provider|cubesandbox-sandbox-provider|cube-persistent-capsule|sandbox-execution|guest-runtime-client)\.ts$/.test(
        file,
      ),
  );
  return {
    storage: storage.length > 0,
    native: native.length > 0,
    reasons: [...new Set([...storage, ...native])],
  };
}

export async function prepareReleasePlan({
  root,
  baseline,
  images,
  revision,
  version,
  forceBuild = [],
}) {
  assert.equal(baseline.formatVersion, 1, "Install the maintained provenance baseline first");
  assert.match(baseline.revision, /^[a-f0-9]{40}$/);
  await git(root, ["merge-base", "--is-ancestor", baseline.revision, revision]);
  const changed = (
    await git(root, ["diff", "--no-renames", "--name-only", `${baseline.revision}..${revision}`])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const impact = releaseImpact(changed);
  const maintenance = physicalMaintenance(changed);
  const artifacts = [];
  const catalog = { ...images };
  const roleComponent = {
    controlPlane: "control-plane",
    sessionRuntime: "session-runtime",
    sessionApi: "session-api",
    toolCompletion: "tool-completion",
    metering: "metering",
    toolHost: "tool-host",
    worker: "supervisor-host",
    volumeGateway: "workspace-volume-gateway",
    web: "web-ui",
    relay: "provider-egress-relay",
    sshGateway: "ssh-gateway",
    provider: "cli-proxy-api",
    cubeAuthorizer: "cube-api-authorizer",
    cubeEgress: "cube-egress-gateway",
  };
  for (const definition of applicationArtifacts) {
    const current = await artifactInputIdentity(root, revision, definition.dockerfile);
    let baseInputs;
    try {
      baseInputs = await artifactInputIdentity(root, baseline.revision, definition.dockerfile);
    } catch {
      /* A new build boundary needs a build. */
    }
    const changedInputs =
      forceBuild.includes(definition.name) || current.identity !== baseInputs?.identity;
    if (changedInputs) {
      const reference = `pi-cloud/${definition.name}:${version}`;
      artifacts.push({
        ...definition,
        artifactId: definition.name,
        action: "build",
        reference,
        inputIdentity: current.identity,
        inputs: current.files,
        sourceRevision: revision,
      });
      for (const role of definition.roles)
        if (Object.hasOwn(catalog, role)) catalog[role] = reference;
      continue;
    }
    // A baseline may intentionally contain independent host role versions after
    // scoped publication. Preserve each role: unchanged current delta does not
    // authorize upgrading unrelated roles to whichever shared image is newest.
    const groups = new Map();
    for (const role of definition.roles) {
      const previous = baseline.components[roleComponent[role]];
      assert(
        previous?.reference && previous.sourceRevision && previous.imageId && previous.evidence,
        `Missing ${role} provenance`,
      );
      const group = groups.get(previous.reference) ?? { previous, roles: [] };
      assert.equal(group.previous.imageId, previous.imageId);
      group.roles.push(role);
      groups.set(previous.reference, group);
    }
    for (const { previous, roles } of groups.values()) {
      const originalInputs = await artifactInputIdentity(
        root,
        previous.sourceRevision,
        definition.dockerfile,
      );
      artifacts.push({
        ...definition,
        roles,
        artifactId: `${definition.name}-${hash(previous.reference).slice(0, 12)}`,
        action: "reuse",
        reference: previous.reference,
        inputIdentity: originalInputs.identity,
        inputs: originalInputs.files,
        sourceRevision: previous.sourceRevision,
        unchangedSince: baseline.revision,
        unchangedInputIdentity: current.identity,
        expectedImageId: previous.imageId,
        priorEvidence: previous.evidence,
      });
    }
  }
  const nativeBuild = JSON.parse(
    await git(root, ["show", `${revision}:deploy/cubesandbox/runtime-build.json`]),
  );
  let nativeChanged = false;
  for (const name of nativeArtifactNames) {
    const previous = baseline.components[name];
    assert(
      previous?.sourceRevision && previous.evidence && previous.reference,
      `Missing ${name} provenance`,
    );
    const prior = JSON.parse(
      await git(root, ["show", `${previous.sourceRevision}:deploy/cubesandbox/runtime-build.json`]),
    );
    nativeChanged ||=
      hash([prior.upstreamCommit, prior.providerContractVersion, prior.nativeImages[name]]) !==
        hash([
          nativeBuild.upstreamCommit,
          nativeBuild.providerContractVersion,
          nativeBuild.nativeImages[name],
        ]) || forceBuild.includes(name);
  }
  const oldNativeVersions = new Set(
    nativeArtifactNames.map((name) => baseline.components[name].reference.split(":").at(-1)),
  );
  assert.equal(oldNativeVersions.size, 1, "Native baseline is not one verified release");
  const nativeVersion = nativeChanged ? version : [...oldNativeVersions][0];
  for (const name of nativeArtifactNames) {
    const previous = baseline.components[name];
    artifacts.push({
      name,
      artifactId: name,
      roles: [name],
      action: nativeChanged ? "pull" : "reuse",
      reference: nativeChanged ? `pi-cloud/${name}:${version}` : previous.reference,
      inputIdentity: hash([
        nativeBuild.upstreamCommit,
        nativeBuild.providerContractVersion,
        nativeBuild.nativeImages[name],
      ]),
      sourceRevision: nativeChanged ? revision : previous.sourceRevision,
      ...(nativeChanged
        ? {}
        : { expectedImageId: previous.imageId, priorEvidence: previous.evidence }),
    });
  }
  const guestIdentity = await guestBuildIdentityAtRevision(root, revision);
  const previousGuest = baseline.components["cubesandbox-tool"];
  const guestChanged = guestIdentity !== baseline.contracts.guestIdentity;
  assert(previousGuest?.sourceRevision && previousGuest.evidence, "Missing Guest provenance");
  artifacts.push({
    name: "cubesandbox-tool",
    artifactId: "cubesandbox-tool",
    roles: ["guest"],
    action: guestChanged ? "build" : "reuse",
    reference: guestChanged
      ? `localhost:5000/pi-cloud/cubesandbox-tool:${guestIdentity}`
      : previousGuest.reference,
    inputIdentity: guestIdentity,
    sourceRevision: guestChanged ? revision : previousGuest.sourceRevision,
    ...(guestChanged
      ? {}
      : { expectedImageId: previousGuest.imageId, priorEvidence: previousGuest.evidence }),
  });
  const physical = maintenance.storage || maintenance.native || nativeChanged || guestChanged;
  const schemaChanged = changed.some((file) =>
    file.startsWith("packages/database/src/migrations/"),
  );
  const component =
    !physical && !schemaChanged && Object.hasOwn(imageReleaseTargets, impact.scope)
      ? impact.scope
      : undefined;
  const neutral = (file) =>
    file === "README.md" ||
    file === "AGENTS.md" ||
    file.startsWith("docs/") ||
    /(?:^|\/)test\/.*\.test\.[cm]?tsx?$/.test(file) ||
    /^scripts\/lib\/.*\.test\.mjs$/.test(file);
  let mode = component ? "component" : "matched";
  if (!physical && !schemaChanged && artifacts.every((a) => a.action === "reuse")) {
    if (!changed.length || changed.every(neutral)) mode = "none";
    const chart = "deploy/helm/pi-cloud-platform/Chart.yaml";
    if (changed.includes(chart) && changed.every((file) => file === chart || neutral(file))) {
      const first = parse(await git(root, ["show", `${baseline.revision}:${chart}`]));
      const next = parse(await git(root, ["show", `${revision}:${chart}`]));
      delete first.version;
      delete next.version;
      if (hash(first) === hash(next)) mode = "metadata";
    }
  }
  return {
    formatVersion: 1,
    baselineDigest: hash(baseline),
    revision,
    version,
    changed,
    mode,
    ...(component ? { scope: component } : {}),
    artifacts,
    drainRoles:
      mode === "matched"
        ? [
            "web",
            "sshGateway",
            "worker",
            "sessionRuntime",
            "sessionApi",
            "toolCompletion",
            "toolHost",
            "controlPlane",
            "volumeGateway",
            "metering",
            "workspaceQuota",
          ]
        : [],
    images: catalog,
    nativeVersion,
    guestIdentity,
    maintenance: {
      ...maintenance,
      physical,
      schemaChanged,
      reasons: [
        ...maintenance.reasons,
        ...(guestChanged ? ["Guest input identity changed"] : []),
        ...(nativeChanged ? ["Native image pins changed"] : []),
      ],
    },
    roles: ["none", "metadata"].includes(mode)
      ? []
      : component
        ? [imageReleaseTargets[component].catalogKey]
        : [...new Set(artifacts.filter((a) => a.action !== "reuse").flatMap((a) => a.roles))],
    gates: component
      ? [component]
      : [
          "matched-source",
          "matched-recovery",
          ...(physical ? ["physical-retirement", "storage-preservation"] : []),
        ],
  };
}
