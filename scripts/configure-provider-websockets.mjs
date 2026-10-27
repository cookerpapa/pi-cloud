import { readFile } from "node:fs/promises";
import { runtimeDirectory, serviceAddress } from "./lib/production-kubernetes.mjs";
import { ensureProviderWebsocketAccounts } from "./lib/provider-websocket-policy.mjs";

const result = await ensureProviderWebsocketAccounts({
  baseUrl: `http://${serviceAddress("cli-proxy-api")}:8317`,
  managementKey: (
    await readFile(`${runtimeDirectory}/secrets/cli-proxy-management-key`, "utf8")
  ).trim(),
});
console.log(JSON.stringify(result));
