import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  constants,
} from "node:fs";
import { resolve } from "node:path";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
configureBuildProxy();
const directory = resolve(process.argv[2] ?? "");
if (!process.argv[2] || directory === "/" || directory === process.cwd())
  throw Error("Usage: prepare-android-target.mjs EMPTY_PRIVATE_DIRECTORY");
const pins = JSON.parse(readFileSync("deploy/android/artifacts.json", "utf8"));
const manifest = resolve(directory, "target.json");
if (existsSync(directory) && !existsSync(manifest))
  throw Error("Refusing an unowned existing directory");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const identity = existsSync(manifest)
  ? JSON.parse(readFileSync(manifest, "utf8"))
  : { targetId: randomUUID(), build: pins.build, target: pins.target, vsockCid: 20003 };
if (identity.build !== pins.build || identity.target !== pins.target)
  throw Error("Existing target uses different artifacts");
const prepared = resolve(directory, "prepared.json");
if (existsSync(prepared)) {
  const previous = JSON.parse(readFileSync(prepared, "utf8"));
  if (JSON.stringify(previous.archives) !== JSON.stringify(pins.archives))
    throw Error("Existing prepared target uses different artifact checksums");
  console.log(
    JSON.stringify({ directory, targetId: identity.targetId, build: pins.build, verified: true }),
  );
  process.exit(0); // Never extract/chown files underneath a running device.
}
if (existsSync(resolve(directory, "deployment.json")))
  throw Error("Deployed target has no preparation receipt; reconcile it before changing artifacts");
writeFileSync(manifest, JSON.stringify(identity, null, 2) + "\n", { mode: 0o600 });
const artifacts = resolve(directory, "artifacts"),
  host = resolve(directory, "host"),
  state = resolve(directory, "state");
for (const path of [artifacts, host, state]) mkdirSync(path, { recursive: true, mode: 0o700 });
async function run(command, args) {
  await new Promise((yes, no) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", no);
    child.once("exit", (code) => (code === 0 ? yes() : no(Error(command + " failed"))));
  });
}
if (process.argv[3]) {
  if (process.argv[3] !== "--artifacts-from" || !process.argv[4])
    throw Error("Expected --artifacts-from VERIFIED_ARCHIVE_DIRECTORY");
  for (const file of Object.keys(pins.archives)) {
    const source = resolve(process.argv[4], file);
    if (!existsSync(resolve(artifacts, file)))
      copyFileSync(source, resolve(artifacts, file), constants.COPYFILE_FICLONE);
  }
}
const hasAll = Object.keys(pins.archives).every((file) => existsSync(resolve(artifacts, file)));
if (!hasAll)
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "--entrypoint",
    "/usr/bin/cvd",
    ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY"].flatMap((k) => [
      "-e",
      k,
    ]),
    "-v",
    artifacts + ":/artifacts",
    pins.fetchImage,
    "fetch",
    "--target_directory=/artifacts",
    "--default_build=" + pins.build + "/" + pins.target,
    "--credential_source=",
    "--use_gce_metadata=false",
    "--enable_caching=false",
    "--keep_downloaded_archives=true",
    "--wait_retry_period=0",
  ]);
for (const [file, expected] of Object.entries(pins.archives)) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(artifacts, file))) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw Error("Android artifact checksum mismatch: " + file);
}
// cvd fetch may substitute host symlinks from its own image. Extract the matching
// archive independently, so runtime binaries actually match the pinned build.
execFileSync("unzip", [
  "-qo",
  resolve(
    artifacts,
    Object.keys(pins.archives).find((name) => name.endsWith(".zip")),
  ),
  "-d",
  artifacts,
]);
execFileSync("tar", ["-xzf", resolve(artifacts, "cvd-host_package.tar.gz"), "-C", host]);
execFileSync("docker", [
  "run",
  "--rm",
  "--entrypoint",
  "/bin/chown",
  "-v",
  directory + ":/target",
  pins.fetchImage,
  "-R",
  `${process.getuid()}:${process.getgid()}`,
  "/target",
]);
writeFileSync(
  prepared,
  JSON.stringify({ archives: pins.archives, at: new Date().toISOString() }) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({ directory, targetId: identity.targetId, build: pins.build, verified: true }),
);
