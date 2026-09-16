import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../run-live-long-context-compaction-check.mjs", import.meta.url),
  "utf8",
);
function fixture(failWait = false, failRestore = false) {
  const calls = [];
  const context = {
    assert,
    process,
    AggregateError,
    workerDeployment: "kubernetes",
    kubernetesArgs: ["--kubeconfig", "/fixture", "--namespace", "pi-cloud-workers"],
    kubernetesStatefulSet: "pi-cloud-pi-worker-local-v1",
    tenantId: "fixture",
    sqlLiteral: JSON.stringify,
    psql: async () => "0",
    waitForWorkers: async (count) => calls.push(["enrolled", count]),
    capture: async (binary, args) => {
      calls.push([binary, args]);
      if (args.includes("get")) return JSON.stringify({ spec: { replicas: 2 } });
      if (args.includes("wait") && failWait) throw new Error("Pod removal failed");
      if (args.includes("rollout") && failRestore) throw new Error("Restore failed");
      return "";
    },
  };
  const declarations = ["stopWorker", "restoreWorker"].map(
    (name) => source.match(new RegExp(`^async function ${name}\\([^]*?^}`, "m"))?.[0],
  );
  assert(declarations.every(Boolean));
  const methods = runInNewContext(
    declarations.join("\n") + "\n({stopWorker,restoreWorker})",
    context,
  );
  return { ...methods, calls, context };
}

describe("long-context local Worker replacement", () => {
  it.each([0, 1])(
    "removes ordinal %s and restores both replicas without retaining an override",
    async (ordinal) => {
      const f = fixture();
      const previous = await f.stopWorker(`pi-cloud-pi-worker-local-v1-${ordinal}`);
      await f.restoreWorker(previous);
      const patches = f.calls
        .filter(([, args]) => Array.isArray(args) && args.includes("--patch"))
        .map(([, args]) => JSON.parse(args[args.indexOf("--patch") + 1]));
      expect(patches).toEqual([
        { spec: { replicas: 1, ordinals: { start: 1 - ordinal } } },
        { spec: { replicas: 2, ordinals: null } },
      ]);
      expect(f.calls.at(-1)).toEqual(["enrolled", 2]);
    },
  );
  it("restores the pool after a partially applied switch", async () => {
    const f = fixture(true);
    await expect(f.stopWorker("pi-cloud-pi-worker-local-v1-0")).rejects.toThrow(
      "Pod removal failed",
    );
    expect(f.calls.at(-1)).toEqual(["enrolled", 2]);
  });
  it("retains both primary and rollback failures", async () => {
    const f = fixture(true, true);
    const failure = await f.stopWorker("pi-cloud-pi-worker-local-v1-0").catch((error) => error);
    expect(failure.errors.map((error) => error.message)).toEqual([
      "Pod removal failed",
      "Restore failed",
    ]);
  });
  it("does not change the pool while foreign work is active", async () => {
    const f = fixture();
    f.context.psql = async () => "1";
    await expect(f.stopWorker("pi-cloud-pi-worker-local-v1-0")).rejects.toThrow("another tenant");
    expect(f.calls).toEqual([]);
  });
});
