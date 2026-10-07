import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { withCubeProxyFixture, restoreCubeProxyFixture } from "./lib/cube-proxy-fixture.mjs";

const restore = process.argv[2] === "--restore";
if (!restore && process.env.PI_CLOUD_LIVE_PROVIDER_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_PROVIDER_CHECK=1 to authorize Cube provider fixtures and temporary egress configuration",
  );
const receiptPath = resolve(
  restore
    ? process.argv[3]
    : (process.env.PI_CLOUD_PROXY_FIXTURE_RECEIPT ?? "dist/provider-proxy-fixture.json"),
);
await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
const values = runtimeEnvironment();
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const api = new PiCloudApi(
  (path, init) =>
    fetch(new URL(String(path), `http://127.0.0.1:${values.PI_CLOUD_HTTP_PORT}`), init),
  (await readFile(resolve(runtimeDirectory, "secrets/api-token"), "utf8")).trim(),
);
try {
  if (restore)
    await restoreCubeProxyFixture(database, JSON.parse(await readFile(receiptPath, "utf8")));
  else
    await withCubeProxyFixture(
      {
        api,
        database,
        fallbackProxyUrl: values.PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY,
        saveReceipt: (receipt) =>
          writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }),
      },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["scripts/run-cubesandbox-provider-live-check.mjs"],
            { stdio: "inherit", env: process.env },
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error("Cube provider acceptance failed")),
          );
        }),
    );
  console.log(JSON.stringify({ completed: true, configurationRestored: true }));
} finally {
  await database.destroy();
}
