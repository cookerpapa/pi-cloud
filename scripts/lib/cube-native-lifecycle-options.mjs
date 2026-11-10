import { kubectl } from "./production-kubernetes.mjs";

/** Owned single-cluster operator connection. Secret contents stay in memory and
 * never enter a shell command, report, model prompt or public runtime descriptor. */
export function nativeCubeLifecycleOptions(run = kubectl) {
  const slices = JSON.parse(
    run(["get", "endpointslices", "-l", "kubernetes.io/service-name=cube-redis", "-o", "json"]),
  );
  const addresses = [
    ...new Set(
      slices.items
        .flatMap((s) => s.endpoints ?? [])
        .filter((e) => e.conditions?.ready !== false)
        .flatMap((e) => e.addresses ?? []),
    ),
  ];
  if (addresses.length !== 1 || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(addresses[0]))
    throw new Error("Native Cube Redis endpoint is unavailable or ambiguous");
  const secret = JSON.parse(run(["get", "secret", "cube-secret", "-o", "json"]));
  const password = Buffer.from(secret.data?.["redis-password"] ?? "", "base64").toString();
  if (!password || password.length > 4096 || /[\u0000-\u001f]/.test(password))
    throw new Error("Native Cube Redis credential is unavailable");
  return { lifecycleRedisUrl: `redis://${addresses[0]}:6379`, lifecycleRedisPassword: password };
}
