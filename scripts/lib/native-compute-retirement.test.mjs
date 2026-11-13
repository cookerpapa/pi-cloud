import { expect, it, vi } from "vitest";
import { nativeComputeRetirement } from "./native-compute-retirement.mjs";

function fixture() {
  const metadata = {
    "picloud.managed": "true",
    "picloud.provider": "cubesandbox",
    "picloud.workspace_runtime_id": "allocation",
    "picloud.tenant_id": "tenant",
    "picloud.project_id": "project",
    "picloud.workspace_id": "workspace",
  };
  const target = {
    providerId: "cubesandbox",
    earlyReceipt: true,
    runtimeName: "owned",
    nodeId: "node",
    instance: { metadata },
  };
  const cube = {
    read: vi.fn(async () => ({ sandboxId: "owned", state: "running", metadata: { ...metadata } })),
    observe: vi.fn(async () => ({ presence: "unavailable" })),
    destroy: vi.fn(async () => {}),
  };
  return { target, cube, native: nativeComputeRetirement({ cube }) };
}
it("requires completed native creation and matching ownership before early-receipt deletion", async () => {
  const f = fixture();
  await expect(f.native.destroy(f.target)).rejects.toThrow("not checked");
  await f.native.assertCreated(f.target);
  await f.native.destroy(f.target);
  expect(f.cube.destroy).toHaveBeenCalledOnce();
});
it.each(["creating", "changed-owner", "missing"])(
  "refuses %s early creation without delete",
  async (kind) => {
    const f = fixture();
    f.cube.read.mockResolvedValue(
      kind === "missing"
        ? null
        : {
            sandboxId: "owned",
            state: kind === "creating" ? "creating" : "running",
            metadata: {
              ...f.target.instance.metadata,
              ...(kind === "changed-owner" ? { "picloud.workspace_id": "other" } : {}),
            },
          },
    );
    await expect(f.native.assertCreated(f.target)).rejects.toThrow();
    expect(f.cube.destroy).not.toHaveBeenCalled();
  },
);
it("accepts positive retained deletion after a lost reply without deleting again", async () => {
  const f = fixture();
  f.cube.read.mockResolvedValue(null);
  f.cube.observe.mockResolvedValue({ presence: "absent" });
  await f.native.assertCreated(f.target);
  await f.native.destroy(f.target);
  expect(f.cube.destroy).not.toHaveBeenCalled();
});
