import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { outageReceipt, restoreControlPlane } from "./owned-control-plane-outage.mjs";

const deployment = (replicas = 1) => ({
  kind: "Deployment",
  metadata: { name: "pi-cloud-control-plane", uid: "original" },
  spec: { replicas, template: { spec: { containers: [{ image: "fixed" }] } } },
});
describe("owned Control Plane outage restoration", () => {
  it("restores the exact original replica count with a zero-replica precondition", () => {
    const receipt = outageReceipt(deployment(2), Date.now() + 1000);
    const invoke = vi.fn(() => JSON.stringify(deployment(0)));
    restoreControlPlane(receipt, invoke);
    expect(invoke.mock.calls[1][0]).toContain("--current-replicas=0");
    expect(invoke.mock.calls[1][0]).toContain("--replicas=2");
  });
  it("does not change an already restored deployment", () => {
    const invoke = vi.fn(() => JSON.stringify(deployment()));
    restoreControlPlane(outageReceipt(deployment(), 0), invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(["identity", "template", "replicas"])("refuses concurrent %s changes", (field) => {
    const current = deployment(0);
    if (field === "identity") current.metadata.uid = "another";
    if (field === "template") current.spec.template.spec.containers[0].image = "another";
    if (field === "replicas") current.spec.replicas = 3;
    const invoke = vi.fn(() => JSON.stringify(current));
    expect(() => restoreControlPlane(outageReceipt(deployment(), 0), invoke)).toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("refuses to own an already stopped deployment", () => {
    expect(() => outageReceipt(deployment(0), 0)).toThrow("already stopped");
  });
  it("restores through the independent watchdog after the caller is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-cloud-outage-watchdog-"));
    try {
      const state = join(dir, "deployment.json"),
        receipt = join(dir, "restore.json"),
        binary = join(dir, "kubectl.mjs");
      await writeFile(state, JSON.stringify(deployment(0)));
      await writeFile(receipt, JSON.stringify(outageReceipt(deployment(), 0)));
      await writeFile(
        binary,
        `#!/usr/bin/env node\nimport fs from 'node:fs';const path=process.env.PI_CLOUD_TEST_DEPLOYMENT;const value=JSON.parse(fs.readFileSync(path));if(process.argv.includes('get'))console.log(JSON.stringify(value));else{if(!process.argv.includes('--current-replicas=0')||value.spec.replicas!==0)process.exit(2);value.spec.replicas=1;fs.writeFileSync(path,JSON.stringify(value));}\n`,
        { mode: 0o700 },
      );
      await promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL("./owned-control-plane-outage.mjs", import.meta.url)),
          "--watch",
          receipt,
        ],
        {
          env: { ...process.env, PI_CLOUD_KUBECTL_BIN: binary, PI_CLOUD_TEST_DEPLOYMENT: state },
          timeout: 10000,
        },
      );
      expect(JSON.parse(await readFile(state, "utf8")).spec.replicas).toBe(1);
      expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
        restored: true,
        watchdog: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
