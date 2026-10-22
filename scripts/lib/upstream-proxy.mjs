import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const proxyVariables = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
];

export function normalizeUpstreamProxy(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Proxy must be an HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /[\x00-\x20\x7f]/u.test(value)
  )
    throw new Error("Proxy must be an HTTP(S) origin without credentials or a path");
  return url.origin;
}

export function configuredUpstreamProxy(
  runtime = resolve(root, process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime"),
) {
  const path = resolve(runtime, "upstream-proxy");
  return existsSync(path) ? normalizeUpstreamProxy(readFileSync(path, "utf8").trim()) : undefined;
}

export function proxyEnvironment(environment, proxy) {
  if (proxy === undefined) return { ...environment };
  const url = normalizeUpstreamProxy(proxy);
  return { ...environment, ...Object.fromEntries(proxyVariables.map((key) => [key, url])) };
}

/** Explicit bootstrap for operator entry points; importing this module is inert. */
export function configureBuildProxy() {
  Object.assign(process.env, proxyEnvironment(process.env, configuredUpstreamProxy()));
}

export function replaceEnvironmentValue(source, key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || /[\r\n]/u.test(value))
    throw new Error("Invalid environment assignment");
  const lines = source.trimEnd().split(/\r?\n/u),
    indexes = lines.flatMap((line, index) => (line.startsWith(key + "=") ? [index] : []));
  if (indexes.length > 1) throw new Error("Duplicate environment setting");
  if (indexes.length) lines[indexes[0]] = key + "=" + value;
  else lines.push(key + "=" + value);
  return lines.join("\n") + "\n";
}

export function dockerProxyDropIn(proxy, noProxy) {
  const url = normalizeUpstreamProxy(proxy);
  if (/[\r\n"\\%]/u.test(noProxy)) throw new Error("Unsupported Docker NO_PROXY value");
  return `[Service]\nEnvironment="HTTP_PROXY=${url}"\nEnvironment="HTTPS_PROXY=${url}"\nEnvironment="NO_PROXY=${noProxy}"\n`;
}

export function k3sProxyEnvironment(source, proxy) {
  const url = normalizeUpstreamProxy(proxy);
  const keys = [
    ...new Set([
      "HTTP_PROXY",
      "HTTPS_PROXY",
      ...source.split(/\r?\n/u).flatMap((line) => {
        const key = line.split("=", 1)[0];
        return /^(?:CONTAINERD_)?(?:HTTPS?|ALL)_PROXY$/iu.test(key) ? [key] : [];
      }),
    ]),
  ];
  return {
    keys,
    content: keys.reduce((text, key) => replaceEnvironmentValue(text, key, url), source),
  };
}
