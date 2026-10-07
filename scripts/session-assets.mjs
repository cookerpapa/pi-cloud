import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { backupAssets, restoreAssets, verifyAssetBackup } from "./lib/asset-recovery.mjs";

const [action, ...argv] = process.argv.slice(2);
if (action === "--help") {
  console.log(
    "Usage: node --import tsx scripts/session-assets.mjs backup|restore|verify --directory PATH [--config PRIVATE_JSON]\nConfig: {databaseUrlFile, images: {endpoint, bucket, region, credentialsFile}}. Restore requires a NEW offline database and empty bucket; it never contacts Cube/Kafka. Backups contain private conversation/account metadata.",
  );
  process.exit(0);
}
if (!["backup", "restore", "verify"].includes(action))
  throw new Error("Choose backup, restore or verify");
const options = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!["--directory", "--config"].includes(argv[i]) || !argv[i + 1])
    throw new Error("Invalid asset-recovery argument");
  options[argv[i].slice(2)] = resolve(argv[i + 1]);
}
if (!options.directory) throw new Error("Provide --directory");
if (action === "verify") {
  const value = await verifyAssetBackup(options.directory);
  console.log(
    JSON.stringify({
      verified: true,
      recoveryPoint: value.createdAt,
      images: value.images.length,
      revision: value.revision,
    }),
  );
} else {
  if (!options.config)
    throw new Error("Provide --config pointing to a private operator configuration");
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const databaseUrl = (await readFile(config.databaseUrlFile, "utf8")).trim();
  const credentials = JSON.parse(await readFile(config.images.credentialsFile, "utf8"));
  const settings = { ...config.images, ...credentials };
  const blobs = new S3ImageBlobStore(settings);
  const client = new S3Client({
    endpoint: settings.endpoint,
    region: settings.region ?? "us-east-1",
    credentials,
    forcePathStyle: true,
    maxAttempts: 2,
  });
  try {
    const started = performance.now();
    const input = { databaseUrl, blobs, directory: options.directory };
    const result =
      action === "backup"
        ? await backupAssets({
            ...input,
            revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          })
        : await restoreAssets({
            ...input,
            async assertEmptyBucket() {
              const page = await client.send(
                new ListObjectsV2Command({ Bucket: settings.bucket, MaxKeys: 1 }),
                { abortSignal: AbortSignal.timeout(30_000) },
              );
              if (page.Contents?.length)
                throw new Error("Restore target attachment bucket must be empty");
            },
          });
    console.log(
      JSON.stringify({
        action,
        completed: true,
        images: Array.isArray(result.images) ? result.images.length : result.images,
        seconds: Math.round((performance.now() - started) / 100) / 10,
        revision: result.revision,
      }),
    );
  } finally {
    blobs.close();
    client.destroy();
  }
}
