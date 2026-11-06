/** Cube v0.7 shares generated BPF bindings with the Cubelet service package.
 * Generate with upstream's pinned builder, never substitute network stubs in a
 * lifecycle test. Inputs are an isolated source export; no live node is touched. */
export async function prepareCubeNetworkBindings(directory, manifest, run) {
  await run("docker", [
    "run",
    "--rm",
    "--network=host",
    "--cpus=2",
    "--memory=2g",
    "-v",
    `${directory}:/source`,
    "-w",
    "/source/CubeNet/cubevs",
    "-e",
    "GOARCH=amd64",
    "-e",
    `GOPROXY=${process.env.PI_CLOUD_GOPROXY ?? "https://goproxy.cn|https://proxy.golang.org|direct"}`,
    ...["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
      .filter((name) => process.env[name])
      .flatMap((name) => ["-e", name]),
    manifest.buildImages.cubeletBuilder,
    "make",
    "gen",
  ]);
}
