import { readFile } from "node:fs/promises";
import { createDeviceGateway } from "./gateway.ts";

async function main() {
  const credentialPath = process.env.PI_CLOUD_DEVICE_LINK_CREDENTIALS_FILE;
  const managementPath = process.env.PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE;
  if (!credentialPath || !managementPath) throw new Error("Device link configuration missing");
  const tokens: unknown = JSON.parse(await readFile(credentialPath, "utf8"));
  if (
    !tokens ||
    typeof tokens !== "object" ||
    Object.values(tokens).some((v) => typeof v !== "string" || v.length < 32)
  )
    throw new Error("Invalid device credentials");
  const server = await createDeviceGateway({
    managementToken: (await readFile(managementPath, "utf8")).trim(),
    deviceToken: async (id) => {
      try {
        const value: unknown = JSON.parse(await readFile(credentialPath, "utf8"));
        const token = (value as Record<string, unknown>)?.[id];
        return typeof token === "string" ? token : undefined;
      } catch {
        return undefined;
      }
    },
  });
  await server.listen({
    host: process.env.PI_CLOUD_DEVICE_LINK_HOST ?? "0.0.0.0",
    port: Number(process.env.PI_CLOUD_DEVICE_LINK_PORT ?? 8090),
  });
  const stop = () => {
    void server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write('{"event":"device_link_ready"}\n');
}
void main().catch(() => {
  process.stderr.write("device_link_start_failed\n");
  process.exitCode = 1;
});
