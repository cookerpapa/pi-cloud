import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function ensureSessionImageConfig(runtimeDirectory, { read, write }) {
  const path = resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json");
  let credentials;
  try {
    credentials = JSON.parse(await read(path));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    credentials = {
      accessKeyId: randomBytes(16).toString("hex"),
      secretAccessKey: randomBytes(32).toString("hex"),
    };
    await write(path, JSON.stringify(credentials) + "\n");
  }
  if (
    !/^[a-f0-9]{32}$/.test(credentials.accessKeyId) ||
    !/^[a-f0-9]{64}$/.test(credentials.secretAccessKey)
  )
    throw new Error("Invalid Session image storage credentials");
  const configPath = resolve(runtimeDirectory, "secrets/session-image-s3-server.json");
  const config = {
    identities: [
      {
        name: "pi-cloud-session-images",
        credentials: [
          { accessKey: credentials.accessKeyId, secretKey: credentials.secretAccessKey },
        ],
        actions: ["Admin", "Read", "Write", "List", "Tagging"],
      },
    ],
  };
  try {
    if (JSON.stringify(JSON.parse(await read(configPath))) !== JSON.stringify(config))
      throw new Error("Image server and client credentials disagree");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await write(configPath, JSON.stringify(config) + "\n");
  }
  await mkdir(resolve(runtimeDirectory, "state/session-images"), { recursive: true, mode: 0o700 });
}
