import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { BoxLiteImageProfile } from "@pi-cloud/sandbox-control/boxlite-node-contract";
import { BoxLiteNodeBackend } from "./backend.ts";
import { createBoxLiteNodeServer } from "./server.ts";

async function main() {
  if (createRequire(import.meta.url)("@boxlite-ai/boxlite/package.json").version !== "0.12.0")
    throw new Error("BoxLite SDK version differs from the pinned contract");
  const file = process.env.PI_CLOUD_BOXLITE_NODE_CONFIG;
  const tokenFile = process.env.PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE;
  if (!file || !tokenFile) throw new Error("BoxLite node configuration is required");
  const config = JSON.parse(await readFile(file, "utf8")) as ConstructorParameters<
    typeof BoxLiteNodeBackend
  >[0] & { port: number };
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(config.nodeId) ||
    !config.directory.startsWith("/") ||
    !config.volumePlugin.startsWith("/") ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    !Array.isArray(config.allowedAddresses) ||
    !config.allowedAddresses.length ||
    !config.profiles
  )
    throw new Error("BoxLite node configuration is invalid");
  for (const profile of Object.values(config.profiles) as BoxLiteImageProfile[]) {
    if (
      !/@sha256:[a-f0-9]{64}$/.test(profile.image) ||
      !Number.isInteger(profile.cpus) ||
      profile.cpus < 1 ||
      !Number.isInteger(profile.memoryMiB) ||
      profile.memoryMiB < 256 ||
      !Number.isInteger(profile.diskGiB) ||
      profile.diskGiB < 1
    )
      throw new Error("A pinned BoxLite image/capacity profile is required");
  }
  const backend = new BoxLiteNodeBackend(config);
  const server = createBoxLiteNodeServer(backend, (await readFile(tokenFile, "utf8")).trim());
  try {
    await backend.prepareImages();
    await backend.ready();
    await server.listen({ host: "0.0.0.0", port: config.port });
    process.stdout.write(
      JSON.stringify({ event: "boxlite_node_ready", nodeId: config.nodeId, sdkVersion: "0.12.0" }) +
        "\n",
    );
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    await server.close();
  }
}

void main().catch(() => {
  process.stderr.write("boxlite_node_failed\n");
  process.exitCode = 1;
});
