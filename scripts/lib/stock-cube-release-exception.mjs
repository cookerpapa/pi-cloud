import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export const STOCK_CUBE_EXCEPTION_PATH = "deploy/cubesandbox/release-exception.json";
export async function acceptedStockCubeImage(root, reference, inspected) {
  const role =
    /^pi-cloud\/(cube-api|cube-master|cube-templatecenter|cubelet):[A-Za-z0-9_.-]+$/.exec(
      reference,
    )?.[1];
  if (!role) return undefined;
  const policy = await readFile(resolve(root, STOCK_CUBE_EXCEPTION_PATH), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  if (!policy || policy.version !== 1 || !policy.id || !Array.isArray(policy.images))
    return undefined;
  const matches = policy.images.filter((entry) => entry.role === role);
  if (matches.length !== 1 || !Array.isArray(inspected?.RootFS?.Layers)) return undefined;
  const approved = matches[0],
    labels = inspected.Config?.Labels ?? {};
  const filesystem = createHash("sha256")
    .update(JSON.stringify(inspected.RootFS.Layers))
    .digest("hex");
  if (
    labels["org.opencontainers.image.base.name"] !== approved.upstream ||
    labels["org.opencontainers.image.base.digest"] !== approved.upstream.split("@")[1] ||
    filesystem !== approved.filesystemLayersSha256 ||
    inspected.Os !== "linux" ||
    inspected.Architecture !== "amd64"
  )
    return undefined;
  return { policyId: policy.id, upstream: approved.upstream, filesystemLayersSha256: filesystem };
}
