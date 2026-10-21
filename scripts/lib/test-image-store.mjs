import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { S3Client, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { S3ImageBlobStore } from "../../packages/session-attachments/src/s3.ts";

const execute = promisify(execFile);

/** Owned SeaweedFS instance, production image pin, no production endpoint or PV. */
export async function testImageStore() {
  const values = parse(
    await readFile(
      new URL("../../deploy/helm/pi-cloud-infrastructure/values.yaml", import.meta.url),
      "utf8",
    ),
  );
  const name = `pi-cloud-test-images-${randomUUID()}`;
  let started = false,
    client,
    blobs;
  const close = async () => {
    blobs?.close();
    client?.destroy();
    if (started) {
      await execute("docker", ["stop", "--timeout=5", name], { timeout: 30_000 });
      started = false;
    }
  };
  try {
    await execute(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--memory=768m",
        "--cpus=2",
        "--publish",
        "127.0.0.1::8333",
        values.sessionImages.image,
        "server",
        "-dir=/data",
        "-ip=127.0.0.1",
        "-ip.bind=0.0.0.0",
        "-s3",
        "-master.volumeSizeLimitMB=64",
        // The pinned master can grow a new collection by seven volumes.
        // Retain its native capacity instead of failing that first allocation.
        "-volume.max=8",
      ],
      { timeout: 300_000 },
    );
    started = true;
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(
      (await execute("docker", ["port", name, "8333/tcp"])).stdout,
    )?.[1];
    if (!port) throw new Error("Image fixture has no loopback port");
    const options = {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "recovery-test",
      region: "us-east-1",
      accessKeyId: "fixture",
      secretAccessKey: "fixture",
    };
    client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: options,
      forcePathStyle: true,
      maxAttempts: 1,
    });
    const deadline = performance.now() + 30_000;
    for (;;) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: options.bucket }), {
          abortSignal: AbortSignal.timeout(1000),
        });
        break;
      } catch {
        if (performance.now() >= deadline) throw new Error("Image fixture did not become ready");
        await delay(200);
      }
    }
    blobs = new S3ImageBlobStore(options);
    return {
      blobs,
      close,
      options,
      async assertEmptyBucket() {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: options.bucket, MaxKeys: 1 }),
        );
        if (page.Contents?.length)
          throw new Error("Restore target attachment bucket must be empty");
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
