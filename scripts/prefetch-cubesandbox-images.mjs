import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdir, mkdtemp, link, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  cubeUpstreamImageClosure,
  createCubeUpstreamEvidence,
  prepareCubeUpstreamImages,
  verifyCubeUpstreamEvidence,
  assertUpstreamArchiveClosure,
  assertImportedUpstreamImages,
} from "./lib/cube-upstream-images.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const arguments_ = process.argv.slice(2);
let manifestPath,
  evidencePath,
  prepareOnly = false;
for (let i = 0; i < arguments_.length; i++) {
  const option = arguments_[i];
  if (option === "--prepare-only" && !prepareOnly) prepareOnly = true;
  else if (option === "--manifest" && !manifestPath && arguments_[i + 1])
    manifestPath = resolve(arguments_[++i]);
  else if (option === "--evidence" && !evidencePath && arguments_[i + 1])
    evidencePath = resolve(arguments_[++i]);
  else
    throw new Error(
      "Usage: node scripts/prefetch-cubesandbox-images.mjs --manifest PATH --evidence PATH [--prepare-only]",
    );
}
assert(
  manifestPath && evidencePath && manifestPath !== evidencePath,
  "Provide separate candidate manifest and upstream image evidence paths",
);

async function boundedFile(path, maximum, privateFile = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    assert(
      stat.isFile() && stat.size <= maximum && (!privateFile || (stat.mode & 0o077) === 0),
      "Candidate evidence must be a bounded private regular file",
    );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
function capture(command, args, timeout = 30_000, allowMissingImage = false) {
  return new Promise((resolvePromise, reject) =>
    execFile(
      command,
      args,
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 ** 2, timeout },
      (error, stdout, stderr) => {
        if (
          error?.code === 1 &&
          allowMissingImage &&
          command === "docker" &&
          args[0] === "image" &&
          args[1] === "inspect" &&
          stderr.trim() === `Error response from daemon: No such image: ${args[2]}`
        )
          return resolvePromise(null);
        if (error)
          reject(new Error(`${command} image operation failed (${error.code ?? "unavailable"})`));
        else resolvePromise(stdout);
      },
    ),
  );
}
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", () => reject(new Error(`${command} image operation could not start`)));
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${command} image operation failed (${code})`)),
    );
  });
}
async function inspect(reference, allowMissing = false) {
  const raw = await capture("docker", ["image", "inspect", reference], 30_000, allowMissing);
  if (raw === null) return null;
  const values = JSON.parse(raw);
  assert(Array.isArray(values) && values.length === 1, "Expected one prepared local image");
  return values[0];
}
async function inspectAll(references) {
  const result = new Map();
  for (const reference of references) result.set(reference, await inspect(reference));
  return result;
}
async function publishEvidence(value) {
  await mkdir(dirname(evidencePath), { recursive: true, mode: 0o700 });
  const temporary = `${evidencePath}.${randomUUID()}.partial`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await link(temporary, evidencePath);
    const directory = await open(dirname(evidencePath), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

const manifest = await boundedFile(manifestPath, 20 * 1024 ** 2, true);
const runtimeBuild = JSON.parse(
  await boundedFile(resolve(root, "deploy/cubesandbox/runtime-build.json"), 1024 ** 2),
);
const closure = cubeUpstreamImageClosure(manifest, runtimeBuild);
let evidence;
try {
  evidence = JSON.parse(await boundedFile(evidencePath, 1024 ** 2, true));
} catch (error) {
  if (error.code !== "ENOENT")
    throw new Error("Existing upstream image evidence is invalid or unavailable");
}

if (prepareOnly) {
  if (!evidence) {
    const inspected = await prepareCubeUpstreamImages(closure.references, {
      inspect: (reference) => inspect(reference, true),
      pull: async (reference) => {
        process.stdout.write(`Preparing missing upstream image ${reference}\n`);
        await run("docker", ["pull", "--platform", "linux/amd64", reference]);
      },
    });
    evidence = createCubeUpstreamEvidence(manifest, runtimeBuild, inspected);
    await publishEvidence(evidence);
  } else {
    verifyCubeUpstreamEvidence(
      manifest,
      runtimeBuild,
      evidence,
      await inspectAll(closure.references),
    );
  }
  process.stdout.write(
    `${JSON.stringify({ prepared: true, images: evidence.images.length, manifestSha256: evidence.manifestSha256 })}\n`,
  );
} else {
  assert(evidence, "Prepare upstream image evidence before importing the candidate");
  const images = verifyCubeUpstreamEvidence(
    manifest,
    runtimeBuild,
    evidence,
    await inspectAll(closure.references),
  );
  assert(
    process.getuid?.() === 0,
    "K3s image import requires root; preparation only needs Docker access",
  );
  for (const image of images)
    assert.equal(
      (await inspect(image.pinnedReference)).Id,
      image.imageId,
      "Prepared digest now resolves to different image bytes",
    );
  const scratch = await mkdtemp(join(tmpdir(), "pi-cloud-upstream-images-"));
  try {
    const archive = join(scratch, "images.tar");
    const ctr = [
      "--address",
      "/run/k3s/containerd/containerd.sock",
      "--namespace",
      "k8s.io",
      "images",
    ];
    for (const image of new Map(images.map((item) => [item.pinnedReference, item])).values()) {
      await run("docker", ["image", "save", "--output", archive, image.pinnedReference]);
      // A legacy Docker export can rewrite registry manifests. Refuse that
      // archive; never manufacture a registry-digest alias for different bytes.
      assertUpstreamArchiveClosure(await capture("tar", ["-tf", archive], 60_000), [image]);
      // Digest-only Docker exports have no repository tag. Give ctr the original
      // repository so it does not invent an import-date name for the same digest.
      await capture(
        "ctr",
        [
          ...ctr,
          "import",
          "--base-name",
          image.pinnedReference.slice(0, image.pinnedReference.lastIndexOf("@")),
          "--digests",
          "--label",
          "io.cri-containerd.pinned=pinned",
          "--platform",
          "linux/amd64",
          archive,
        ],
        10 * 60_000,
      );
      assertImportedUpstreamImages(await capture("ctr", [...ctr, "list"]), [image]);
      await rm(archive);
    }
    assertImportedUpstreamImages(await capture("ctr", [...ctr, "list"]), images);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({ imported: true, images: images.length, manifestSha256: evidence.manifestSha256 })}\n`,
  );
}
