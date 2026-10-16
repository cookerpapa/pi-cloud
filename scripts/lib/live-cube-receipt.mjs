import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialCubeSandboxRuntimeClient } from "../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { kubectl, repositoryRoot, runtimeDirectory } from "./production-kubernetes.mjs";

/** Real native driver/guest fault injection, confined to this acceptance VM. */
export async function checkOwnedGuestReceipt({ tenantId, workspaceId }) {
  const cluster = JSON.parse(
    await readFile(join(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const client = new OfficialCubeSandboxRuntimeClient({
    apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
    apiKey: (await readFile(join(runtimeDirectory, "secrets/cubesandbox-api-key"), "utf8")).trim(),
    proxyNodeIp: cluster.proxy.host,
    proxyPort: cluster.proxy.port,
    proxyScheme: "http",
    sandboxDomain: cluster.sandboxDomain,
    egressProxyIp: "10.255.255.254",
  });
  const temporary = await mkdtemp(join(tmpdir(), "pi-cloud-live-receipt-"));
  const remote = "/tmp/pi-cloud-receipt-" + randomUUID();
  let pod;
  const exec = promisify(execFile);
  const run = (command, args, options = {}) =>
    exec(command, args, {
      cwd: repositoryRoot,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
      ...options,
    });
  try {
    const instances = (await client.list()).filter(
      (instance) =>
        instance.metadata["picloud.tenant_id"] === tenantId &&
        instance.metadata["picloud.workspace_id"] === workspaceId,
    );
    assert.equal(instances.length, 1, "Expected exactly one owned acceptance VM");
    assert.equal(instances[0].state, "running", "Owned acceptance VM is not running");
    const pods = JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.filter(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.spec.containers.some((c) => c.name === "cubelet") &&
        p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    // This maintained fault fixture is deliberately single-node. Never guess a
    // compute-node mapping in a distributed deployment.
    assert.equal(pods.length, 1, "Receipt fault fixture requires one Ready Cubelet");
    pod = pods[0].metadata.name;
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "deploy/cubesandbox/runtime-build.json"), "utf8"),
    );
    await run("git", [
      "-C",
      process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? join(homedir(), "CubeSandbox"),
      "archive",
      "--format=tar",
      `--output=${join(temporary, "source.tar")}`,
      manifest.upstreamCommit,
    ]);
    await run("tar", ["-xf", join(temporary, "source.tar"), "-C", temporary]);
    for (const patch of manifest.patches) {
      const path = join(repositoryRoot, "deploy/cubesandbox/patches", patch.file);
      assert.equal(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        patch.sha256,
      );
      await run("git", ["apply", path], { cwd: temporary });
    }
    const source = join(repositoryRoot, "scripts/fixtures/live-cube-receipt.go");
    const binary = join(temporary, "receipt-check");
    await run("go", ["build", "-mod=readonly", "-o", binary, source], {
      cwd: join(temporary, "Cubelet"),
      env: { ...process.env, CGO_ENABLED: "0" },
    });
    const sourceSha256 = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    kubectl(["cp", binary, `${pod}:${remote}`, "-c", "cubelet"], { timeout: 30000 });
    const result = JSON.parse(
      kubectl(
        [
          "exec",
          pod,
          "-c",
          "cubelet",
          "--",
          remote,
          "/data/cubelet/cubelet.sock",
          instances[0].sandboxId,
        ],
        { timeout: 90000 },
      ),
    );
    assert.equal(result.accepted, true, "Native receipt fault did not pass");
    return {
      ...result,
      sourceSha256,
      cubeCommit: manifest.upstreamCommit,
      scope:
        "Owned live VM and exact patched native driver; only its one receipt is filtered. Admission/Kafka are covered by the ordinary Run checks.",
    };
  } finally {
    try {
      if (pod)
        kubectl(["exec", pod, "-c", "cubelet", "--", "rm", "-f", remote], { timeout: 15000 });
    } finally {
      try {
        await client.close();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
}
