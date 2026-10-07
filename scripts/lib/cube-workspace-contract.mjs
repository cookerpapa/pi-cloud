/** Helm chart upgrades can overwrite installer patches. Refuse application
 * rollout if Cube and the Volume Gateway would see different Workspace bytes. */
export function assertCubeWorkspaceContract(master, node, expectedHostRoot) {
  const requiredMount = (pod, containerName, path, hostRoot) => {
    const container = pod.spec.template.spec.containers.find((item) => item.name === containerName);
    const mount = container?.volumeMounts?.find((item) => item.mountPath === path);
    const volume = pod.spec.template.spec.volumes.find((item) => item.name === mount?.name);
    if (!mount || volume?.hostPath?.path !== hostRoot)
      throw new Error(
        `Cube ${containerName} Workspace mount drifted; rerun the Cube installer before deployment`,
      );
  };
  requiredMount(master, "cube-master", "/data/cube-shared", expectedHostRoot);
  requiredMount(node, "cubelet", "/data/cube-shared", expectedHostRoot);
  requiredMount(node, "network-agent", "/data/cube-shared", expectedHostRoot);
  for (const [resource, containerName, mountPath] of [
    [
      master,
      "cube-master",
      "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
    ],
    [node, "cubelet", "/opt/cube-image/Cubelet/plugin/cube-volume-picloud-posix"],
  ]) {
    const pod = resource.spec.template.spec;
    const executable = pod.containers
      .find((c) => c.name === containerName)
      ?.volumeMounts?.find((m) => m.mountPath === mountPath);
    const mounted = pod.volumes.find((v) => v.name === executable?.name);
    if (
      executable?.subPath !== "cube-volume-picloud-posix" ||
      executable.readOnly !== true ||
      mounted?.configMap?.name !== "pi-cloud-posix-volume-plugin"
    )
      throw new Error(
        "Cube POSIX plugin executable mount drifted; rerun the Cube installer before deployment",
      );
  }
  const cubelet = node.spec.template.spec.containers.find((item) => item.name === "cubelet");
  const config = cubelet?.volumeMounts?.find(
    (item) => item.mountPath === "/opt/cube-image/Cubelet/config/config.toml",
  );
  const volume = node.spec.template.spec.volumes.find((item) => item.name === config?.name);
  if (
    config?.subPath !== "cubelet-config.toml" ||
    config.readOnly !== true ||
    volume?.configMap?.name !== "pi-cloud-posix-volume-plugin"
  )
    throw new Error(
      "Cube POSIX plugin configuration drifted; rerun the Cube installer before deployment",
    );
}

export function assertCubeCompletionVersion(probe, sourceId, patchId) {
  if (probe?.source !== sourceId || probe?.version !== `0.6.0-picloud-${patchId}`)
    throw new Error(
      "Update Cubelet from the current pinned runtime and completion sources before deploying the platform",
    );
}
