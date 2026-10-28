import { imageReleaseTargets } from "./lib/release-impact.mjs";
import { configureBuildProxy, proxyDownloadNetwork } from "./lib/upstream-proxy.mjs";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { guestBuildIdentity } from "./lib/guest-build-identity.mjs";
import { inspectReleaseImage, assertGuestInventory } from "./lib/release-image-evidence.mjs";

configureBuildProxy();

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const TRIVY_IMAGE =
  "aquasec/trivy@sha256:be1190afcb28352bfddc4ddeb71470835d16462af68d310f9f4bca710961a41e";
const TRIVY_IGNORE_POLICY = resolve(repositoryRoot, ".trivyignore.yaml");
const PRODUCTION_IMAGE_NAMES = [
  "control-plane",
  "supervisor-host",
  "workspace-volume-gateway",
  "web-ui",
  "provider-egress-relay",
  "ssh-gateway",
  "cli-proxy-api",
];
const CUBE_PLATFORM_IMAGES = ["cube-api", "cube-master", "cubelet", "cube-api-authorizer"];
const MAX_CAPTURE_BYTES = 64 * 1_024 * 1_024;

function parseArguments(argv) {
  const result = {
    outputDirectory: resolve(repositoryRoot, "dist/release-evidence"),
    cacheDirectory:
      process.env.PI_CLOUD_TRIVY_CACHE_DIRECTORY ??
      resolve(repositoryRoot, ".cache/pi-cloud-trivy"),
    imageVersion: process.env.PI_CLOUD_IMAGE_VERSION ?? "production",
    allowDirty: false,
    component: "all",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--output-dir", "--cache-dir", "--image-version", "--component"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      if (argument === "--output-dir") result.outputDirectory = resolve(repositoryRoot, value);
      if (argument === "--cache-dir") result.cacheDirectory = resolve(repositoryRoot, value);
      if (argument === "--image-version") result.imageVersion = value;
      if (argument === "--component") {
        if (!["all", "provider", "web", "control-plane", "android"].includes(value))
          throw new Error("Unsupported evidence scope");
        result.component = value;
      }
      index += 1;
      continue;
    }
    if (argument === "--allow-dirty") {
      result.allowDirty = true;
      continue;
    }
    if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run release:evidence -- [--output-dir EMPTY_PATH] [--cache-dir PATH] [--image-version VERSION] [--component all|provider|web|control-plane|android] [--allow-dirty]\n",
      );
      process.exit(0);
    }
    throw new Error(`Unknown release-evidence argument: ${argument}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.imageVersion)) {
    throw new Error("Image version must contain only tag-safe characters");
  }
  if (!isAbsolute(result.outputDirectory) || !isAbsolute(result.cacheDirectory)) {
    throw new Error("Resolved evidence paths must be absolute");
  }
  return result;
}

function commandFailure(command, arguments_, error, stderr) {
  const detail = stderr.trim().slice(-2_000);
  return new Error(
    `${command} ${arguments_.join(" ")} failed (${error.message})${detail ? `: ${detail}` : ""}`,
  );
}

function capture(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      arguments_,
      {
        cwd: options.cwd ?? repositoryRoot,
        env: options.environment ?? process.env,
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES,
        timeout: options.timeoutMs ?? 300_000,
      },
      (error, stdout, stderr) => {
        if (error) rejectPromise(commandFailure(command, arguments_, error, stderr));
        else resolvePromise(stdout.trim());
      },
    );
  });
}

function run(command, arguments_, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.environment ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", () => rejectPromise(new Error(`${command} could not start`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(`${command} failed (code=${String(code)}, signal=${String(signal)})`),
        );
      }
    });
  });
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function fileEvidence(root, path) {
  const absolute = resolve(root, path);
  return {
    path,
    sha256: await sha256File(absolute),
    sizeBytes: (await stat(absolute)).size,
  };
}

function trivyContainerArguments({
  cacheDirectory,
  inputDirectory,
  outputDirectory,
  network,
  temporaryMiB = 256,
  temporaryDiskDirectory,
}) {
  const uid = process.getuid?.() ?? 1_000;
  const gid = process.getgid?.() ?? 1_000;
  return [
    "run",
    "--rm",
    "--network",
    network,
    ...(network === "none"
      ? []
      : ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
          .filter((key) => process.env[key])
          .flatMap((key) => ["--env", key])),
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    `${String(uid)}:${String(gid)}`,
    ...(temporaryDiskDirectory
      ? ["--mount", `type=bind,source=${temporaryDiskDirectory},target=/tmp`]
      : ["--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${temporaryMiB}m`]),
    "--mount",
    `type=bind,source=${cacheDirectory},target=/cache`,
    "--mount",
    `type=bind,source=${inputDirectory},target=/input,readonly`,
    "--mount",
    `type=bind,source=${outputDirectory},target=/output`,
    "--mount",
    `type=bind,source=${TRIVY_IGNORE_POLICY},target=/policy/.trivyignore.yaml,readonly`,
    TRIVY_IMAGE,
  ];
}

function vulnerabilitySummary(report) {
  const summary = {
    HIGH: { total: 0, fixable: 0 },
    CRITICAL: { total: 0, fixable: 0 },
  };
  for (const result of report.Results ?? []) {
    for (const vulnerability of result.Vulnerabilities ?? []) {
      if (vulnerability.Severity !== "HIGH" && vulnerability.Severity !== "CRITICAL") continue;
      summary[vulnerability.Severity].total += 1;
      if (typeof vulnerability.FixedVersion === "string" && vulnerability.FixedVersion !== "") {
        summary[vulnerability.Severity].fixable += 1;
      }
    }
  }
  return summary;
}

async function prepareDestination(path) {
  if (await exists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Release evidence destination must be a real directory");
    }
    if ((await readdir(path)).length > 0) {
      throw new Error("Release evidence destination must be absent or empty");
    }
    await rm(path, { recursive: true });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

const options = parseArguments(process.argv.slice(2));
if (!["bridge", "host"].includes(process.env.PI_CLOUD_TRIVY_DOWNLOAD_NETWORK ?? "bridge"))
  throw new Error("PI_CLOUD_TRIVY_DOWNLOAD_NETWORK must be bridge or host");
const revision = await capture("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Git HEAD is not a full commit SHA");
const dirty = (await capture("git", ["status", "--porcelain"])).length > 0;
if (dirty && !options.allowDirty) {
  throw new Error("Refusing release evidence from a dirty worktree; commit or pass --allow-dirty");
}
await prepareDestination(options.outputDirectory);
await mkdir(options.cacheDirectory, { recursive: true, mode: 0o700 });
const destinationParent = dirname(options.outputDirectory);
const stageDirectory = await mkdtemp(join(destinationParent, ".pi-cloud-release-"));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-cloud-release-"));

try {
  await mkdir(resolve(stageDirectory, "images"), { mode: 0o700 });
  const rootSbomPath = resolve(stageDirectory, "pi-cloud-root.cdx.json");
  const rootSbom = await capture("npm", ["sbom", "--sbom-format=cyclonedx", "--omit=dev"]);
  JSON.parse(rootSbom);
  await writeFile(rootSbomPath, `${rootSbom}\n`, { mode: 0o600 });
  await writeFile(
    resolve(stageDirectory, ".trivyignore.yaml"),
    await readFile(TRIVY_IGNORE_POLICY),
    { mode: 0o600 },
  );

  const trivyBase = trivyContainerArguments({
    cacheDirectory: options.cacheDirectory,
    inputDirectory: temporaryDirectory,
    outputDirectory: stageDirectory,
    network: proxyDownloadNetwork(
      process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY,
      process.env.PI_CLOUD_TRIVY_DOWNLOAD_NETWORK,
    ),
    // OCI download keeps temporary archive copies; the current compressed DB
    // exceeds 128 MiB. Image scans below retain their separate 256 MiB bound.
    temporaryMiB: 512,
  });
  await run("docker", [
    ...trivyBase,
    "image",
    "--cache-dir",
    "/cache",
    "--download-db-only",
    "--timeout",
    "15m",
    "--no-progress",
    ...(process.env.PI_CLOUD_TRIVY_DB_REPOSITORY
      ? ["--db-repository", process.env.PI_CLOUD_TRIVY_DB_REPOSITORY]
      : []),
  ]);

  if (options.component === "all" || options.component === "android") {
    // The Java index downloader keeps multiple archive copies. Use owned disk
    // scratch, not a multi-GiB tmpfs competing with running VMs.
    const javaScratch = resolve(temporaryDirectory, "java-download");
    await mkdir(javaScratch, { mode: 0o700 });
    await run("docker", [
      ...trivyContainerArguments({
        cacheDirectory: options.cacheDirectory,
        inputDirectory: temporaryDirectory,
        outputDirectory: stageDirectory,
        network: proxyDownloadNetwork(
          process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY,
          process.env.PI_CLOUD_TRIVY_DOWNLOAD_NETWORK,
        ),
        temporaryDiskDirectory: javaScratch,
      }),
      "image",
      "--cache-dir",
      "/cache",
      "--download-java-db-only",
      "--no-progress",
    ]);
  }

  const images = [];
  const guestIdentity =
    options.component === "all" ? await guestBuildIdentity(repositoryRoot) : undefined;
  const imageDescriptors =
    options.component === "android"
      ? ["android-runtime", "android-automation", "android-executor", "android-egress"].map(
          (imageName) => ({
            imageName,
            reference: `pi-cloud/${imageName}:${options.imageVersion}`,
            labelVersion: options.imageVersion,
          }),
        )
      : options.component !== "all"
        ? [
            {
              imageName: imageReleaseTargets[options.component].imageName,
              reference: `pi-cloud/${imageReleaseTargets[options.component].imageName}:${options.imageVersion}`,
              labelVersion: options.imageVersion,
            },
          ]
        : [
            ...PRODUCTION_IMAGE_NAMES.map((imageName) => ({
              imageName,
              reference: `pi-cloud/${imageName}:${options.imageVersion}`,
              labelVersion: options.imageVersion,
            })),
            ...CUBE_PLATFORM_IMAGES.map((imageName) => ({
              imageName,
              reference: `pi-cloud/${imageName}:${options.imageVersion}`,
              labelVersion: options.imageVersion,
            })),
            {
              imageName: "cubesandbox-tool",
              reference: `localhost:5000/pi-cloud/cubesandbox-tool:${guestIdentity}`,
              labelVersion: "cube-primary",
              guestIdentity,
            },
          ];
  for (const { imageName, ...descriptor } of imageDescriptors) {
    const { reference } = descriptor;
    const evidence = await inspectReleaseImage(
      { ...descriptor, releaseRevision: revision, repositoryRoot },
      capture,
    );
    const archiveName = `${imageName}.tar`;
    const archivePath = resolve(temporaryDirectory, archiveName);
    await run("docker", ["image", "save", "--output", archivePath, reference]);
    await chmod(archivePath, 0o600);

    const outputRoot = `images/${imageName}`;
    const reportRelativePath = `${outputRoot}.vulnerabilities.json`;
    const policyReportRelativePath = `${outputRoot}.policy-vulnerabilities.json`;
    const sbomRelativePath = `${outputRoot}.cdx.json`;
    // Language analysis copies Chromium/JDK binaries; owned disk scratch avoids
    // a large RAM-backed temporary mount competing with running KVM guests.
    const scanScratch =
      imageName === "cubesandbox-tool" ? resolve(temporaryDirectory, "guest-scan") : undefined;
    if (scanScratch) await mkdir(scanScratch, { mode: 0o700 });
    const scanBase = trivyContainerArguments({
      cacheDirectory: options.cacheDirectory,
      inputDirectory: temporaryDirectory,
      outputDirectory: stageDirectory,
      network: "none",
      ...(scanScratch ? { temporaryDiskDirectory: scanScratch } : {}),
    });
    const common = [
      "image",
      "--cache-dir",
      "/cache",
      "--input",
      `/input/${archiveName}`,
      "--skip-db-update",
      "--skip-java-db-update",
      "--scanners",
      "vuln",
      "--severity",
      "HIGH,CRITICAL",
      "--pkg-types",
      "os,library",
    ];
    await run("docker", [
      ...scanBase,
      ...common,
      "--format",
      "json",
      "--output",
      `/output/${reportRelativePath}`,
    ]);
    await run("docker", [
      ...scanBase,
      ...common,
      "--format",
      "cyclonedx",
      "--output",
      `/output/${sbomRelativePath}`,
    ]);
    await run("docker", [
      ...scanBase,
      ...common,
      "--ignorefile",
      "/policy/.trivyignore.yaml",
      "--format",
      "json",
      "--output",
      `/output/${policyReportRelativePath}`,
    ]);
    const report = JSON.parse(await readFile(resolve(stageDirectory, reportRelativePath), "utf8"));
    const policyReport = JSON.parse(
      await readFile(resolve(stageDirectory, policyReportRelativePath), "utf8"),
    );
    if (imageName === "cubesandbox-tool") assertGuestInventory(report);
    const vulnerabilities = vulnerabilitySummary(report);
    const policyVulnerabilities = vulnerabilitySummary(policyReport);
    images.push({
      ...evidence,
      vulnerabilities,
      policyVulnerabilities,
      vulnerabilityReport: await fileEvidence(stageDirectory, reportRelativePath),
      policyVulnerabilityReport: await fileEvidence(stageDirectory, policyReportRelativePath),
      sbom: await fileEvidence(stageDirectory, sbomRelativePath),
    });
  }

  const blocked = images.filter(
    (image) =>
      image.policyVulnerabilities.HIGH.fixable > 0 ||
      image.policyVulnerabilities.CRITICAL.fixable > 0,
  );
  const manifest = {
    format: "pi-cloud.release-evidence.v1",
    generatedAt: new Date().toISOString(),
    git: { revision, dirty },
    imageVersion: options.imageVersion,
    scope: options.component,
    policy: {
      scanner: TRIVY_IMAGE,
      severities: ["HIGH", "CRITICAL"],
      reportUnfixed: true,
      maximumFixableFindings: 0,
      exceptionPolicy: await fileEvidence(stageDirectory, ".trivyignore.yaml"),
      packageTypes: ["os", "library"],
    },
    rootSbom: await fileEvidence(stageDirectory, relative(stageDirectory, rootSbomPath)),
    images,
  };
  const manifestPath = resolve(stageDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const evidencePaths = [
    "pi-cloud-root.cdx.json",
    ".trivyignore.yaml",
    "manifest.json",
    ...images.flatMap((image) => [
      image.sbom.path,
      image.vulnerabilityReport.path,
      image.policyVulnerabilityReport.path,
    ]),
  ].toSorted();
  const checksums = await Promise.all(
    evidencePaths.map(
      async (path) => `${await sha256File(resolve(stageDirectory, path))}  ${path}`,
    ),
  );
  await writeFile(resolve(stageDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
    mode: 0o600,
  });

  if (blocked.length > 0) {
    throw new Error(
      `Release blocked by fixable HIGH/CRITICAL findings: ${blocked
        .map(
          (image) =>
            `${image.reference} (policy fixable HIGH=${String(image.policyVulnerabilities.HIGH.fixable)}, policy fixable CRITICAL=${String(image.policyVulnerabilities.CRITICAL.fixable)})`,
        )
        .join(", ")}`,
    );
  }
  await rename(stageDirectory, options.outputDirectory);
  process.stdout.write(
    `${JSON.stringify({ releaseEvidence: "passed", outputDirectory: options.outputDirectory, revision, dirty, images: images.length })}\n`,
  );
} catch (error) {
  process.stderr.write(`Release evidence retained for diagnosis at ${stageDirectory}\n`);
  throw error;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
