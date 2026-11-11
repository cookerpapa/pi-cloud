import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

/** Used only after application admission is stopped. Starting the API for this
 * read does not start a VM; the pinned SDK inventory is an observation port. */
export async function assertBoxLiteEmpty({ kubectl }) {
  const raw = kubectl([
    "get",
    "statefulset",
    "pi-cloud-boxlite",
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (!raw.trim()) return;
  const set = JSON.parse(raw),
    previous = set.spec.replicas ?? 1;
  assert([0, 1].includes(previous), "Unexpected BoxLite node replica count");
  const selector = "app.kubernetes.io/instance=pi-cloud-boxlite";
  if (previous === 0) kubectl(["scale", "statefulset/pi-cloud-boxlite", "--replicas=1"]);
  try {
    let pod;
    const until = Date.now() + 120000;
    while (!pod && Date.now() < until) {
      pod = JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items.find(
        (item) =>
          !item.metadata.deletionTimestamp &&
          item.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      );
      if (!pod) await delay(1000);
    }
    assert(pod, "BoxLite API inventory is unavailable; do not infer physical absence");
    const source = `const fs=await import('node:fs/promises');
const token=(await fs.readFile(process.env.PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE,'utf8')).trim();
const r=await fetch('http://127.0.0.1:8091/internal/v1/boxlite/inventory',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)});
if(!r.ok)throw Error('Inventory unavailable');process.stdout.write(JSON.stringify(await r.json()));`;
    const counts = JSON.parse(
      kubectl([
        "exec",
        pod.metadata.name,
        "-c",
        "node",
        "--",
        "node",
        "--input-type=module",
        "-e",
        source,
      ]),
    );
    assert.deepEqual(
      counts,
      { native: 0, receipts: 0, creating: 0 },
      "BoxLite allocations or unresolved receipts remain; retain their ownership",
    );
  } finally {
    if (previous === 0) {
      kubectl(["scale", "statefulset/pi-cloud-boxlite", "--replicas=0"]);
      if (JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items.length)
        kubectl(["wait", "--for=delete", "pod", "-l", selector, "--timeout=120s"], {
          timeout: 125000,
        });
    }
  }
}
