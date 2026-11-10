import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { acceptedStockCubeImage } from "./stock-cube-release-exception.mjs";

it("limits approval to an exact upstream filesystem and four native roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pma-exception-"));
  const upstream = `official/cube-api@sha256:${"a".repeat(64)}`,
    layers = ["sha256:" + "b".repeat(64)];
  const inspected = {
    Os: "linux",
    Architecture: "amd64",
    RootFS: { Layers: layers },
    Config: {
      Labels: {
        "org.opencontainers.image.base.name": upstream,
        "org.opencontainers.image.base.digest": upstream.split("@")[1],
      },
    },
  };
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await writeFile(
      join(root, "deploy/cubesandbox/release-exception.json"),
      JSON.stringify({
        version: 1,
        id: "reviewed",
        images: [
          {
            role: "cube-api",
            upstream,
            filesystemLayersSha256: createHash("sha256")
              .update(JSON.stringify(layers))
              .digest("hex"),
          },
        ],
      }),
    );
    expect(
      await acceptedStockCubeImage(root, "pi-cloud/cube-api:release-1", inspected),
    ).toMatchObject({ policyId: "reviewed", upstream });
    expect(
      await acceptedStockCubeImage(root, "pi-cloud/control-plane:release-1", inspected),
    ).toBeUndefined();
    expect(
      await acceptedStockCubeImage(root, "pi-cloud/cube-api:release-1", {
        ...inspected,
        RootFS: { Layers: [...layers, "extra"] },
      }),
    ).toBeUndefined();
    expect(
      await acceptedStockCubeImage(root, "pi-cloud/cube-api:release-1", {
        ...inspected,
        Config: { Labels: {} },
      }),
    ).toBeUndefined();
    expect(
      await acceptedStockCubeImage(root, "pi-cloud/cube-master:release-1", inspected),
    ).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
