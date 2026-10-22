import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  normalizeUpstreamProxy,
  proxyEnvironment,
  configuredUpstreamProxy,
  replaceEnvironmentValue,
  dockerProxyDropIn,
  k3sProxyEnvironment,
  proxyVariables,
  proxyDownloadNetwork,
} from "./upstream-proxy.mjs";

it("reaches host-local proxies from the database-download container and retains explicit network choices", () => {
  expect(proxyDownloadNetwork("http://127.0.0.1:12450")).toBe("host");
  expect(proxyDownloadNetwork("http://[::1]:12450")).toBe("host");
  expect(proxyDownloadNetwork("http://proxy.example:12450")).toBe("bridge");
  expect(proxyDownloadNetwork(undefined)).toBe("bridge");
  expect(proxyDownloadNetwork("http://127.0.0.1:12450", "custom-network")).toBe("custom-network");
});

it("updates K3s and containerd proxy assignments while preserving tokens and bypasses", () => {
  const source =
    "K3S_TOKEN=fixture-token\nHTTPS_PROXY='http://old:18080'\nCONTAINERD_HTTP_PROXY=http://old:18080\nNO_PROXY=localhost,10.0.0.0/8\n";
  const next = k3sProxyEnvironment(source, "http://127.0.0.1:12450");
  expect(next.content).toContain("K3S_TOKEN=fixture-token\n");
  expect(next.content).toContain("NO_PROXY=localhost,10.0.0.0/8\n");
  expect(next.content).not.toContain("old:18080");
  expect(next.keys.sort()).toEqual(["CONTAINERD_HTTP_PROXY", "HTTPS_PROXY", "HTTP_PROXY"].sort());
  expect(k3sProxyEnvironment(next.content, "http://127.0.0.1:12450").content).toBe(next.content);
});

it("uses the current persisted address instead of stale inherited proxy aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloud-proxy-test-"));
  try {
    expect(configuredUpstreamProxy(directory)).toBeUndefined();
    await writeFile(join(directory, "upstream-proxy"), "http://127.0.0.1:12450/\n");
    const env = proxyEnvironment(
      {
        HTTP_PROXY: "http://stale:18080",
        all_proxy: "socks5://stale:18080",
        NO_PROXY: "localhost",
        UNRELATED: "keep",
      },
      configuredUpstreamProxy(directory),
    );
    for (const key of proxyVariables) expect(env[key]).toBe("http://127.0.0.1:12450");
    expect(env.NO_PROXY).toBe("localhost");
    expect(env.UNRELATED).toBe("keep");
    await writeFile(join(directory, "upstream-proxy"), "https://proxy.example:9443\n");
    expect(configuredUpstreamProxy(directory)).toBe("https://proxy.example:9443");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("updates one deployment setting without rewriting unrelated settings and is repeatable", () => {
  const text =
    "# operator settings\nUNCHANGED=value\nPI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY=http://old:18080\n";
  const next = replaceEnvironmentValue(
    text,
    "PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY",
    "http://127.0.0.1:12450",
  );
  expect(next).toBe(
    "# operator settings\nUNCHANGED=value\nPI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY=http://127.0.0.1:12450\n",
  );
  expect(
    replaceEnvironmentValue(
      next,
      "PI_CLOUD_PROVIDER_RELAY_UPSTREAM_PROXY",
      "http://127.0.0.1:12450",
    ),
  ).toBe(next);
  expect(() => replaceEnvironmentValue("KEY=one\nKEY=two\n", "KEY", "new")).toThrow("Duplicate");
});

it("rejects proxy values that cannot be shared with Cube or safely serialized", () => {
  for (const value of [
    "socks5://localhost:12450",
    "http://user:password@localhost:12450",
    "http://localhost:12450/path",
    "http://localhost:12450/?token=x",
    "http://localhost:12450\nEVIL=x",
  ])
    expect(() => normalizeUpstreamProxy(value)).toThrow();
  expect(dockerProxyDropIn("http://127.0.0.1:12450", "localhost,.svc")).toBe(
    '[Service]\nEnvironment="HTTP_PROXY=http://127.0.0.1:12450"\nEnvironment="HTTPS_PROXY=http://127.0.0.1:12450"\nEnvironment="NO_PROXY=localhost,.svc"\n',
  );
  expect(() => dockerProxyDropIn("http://localhost:12450", 'localhost"\nExecStart=x')).toThrow();
});
