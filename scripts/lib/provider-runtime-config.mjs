import { stringify } from "yaml";

export const providerManagementAsset = Object.freeze({
  repository:
    "https://api.github.com/repos/router-for-me/Cli-Proxy-API-Management-Center/releases/tags/v1.27.3",
  url: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/v1.27.3/management.html",
  sha256: "14d3f48af2294f8bf65cc9d2d92eb9a477b47a2fb38a26f820debf6801a05bc9",
});

/** One current layout. Existing deployments use the explicit v8 release converter. */
export function initialProviderConfiguration({ apiKey, managementKey }) {
  if (typeof apiKey !== "string" || !apiKey || typeof managementKey !== "string" || !managementKey)
    throw new Error("Provider initialization requires both credentials");
  return stringify({
    "config-version": 8,
    server: { host: "0.0.0.0", port: 8317, tls: { enable: false } },
    management: {
      "allow-remote": true,
      "secret-key": managementKey,
      "disable-control-panel": false,
      "disable-auto-update-panel": true,
      "panel-github-repository": providerManagementAsset.repository,
    },
    access: { "api-keys": [apiKey] },
    oauth: { "auth-dir": "/data/auth" },
    observability: {
      logs: { debug: false, "logging-to-file": false },
      usage: { "usage-statistics-enabled": true },
    },
    requests: { "proxy-url": "http://provider-egress-relay:3129" },
    routing: {
      strategy: "round-robin",
      "session-affinity": true,
      "session-affinity-ttl": "1h",
      retry: { "request-retry": 0, "max-retry-credentials": 0, "max-retry-interval": 5 },
      cooldown: { "transient-error-cooldown-seconds": -1 },
    },
    upstream: { codex: { "disable-codex-cloaking": false, "stream-bootstrap-buffering": false } },
    multimedia: { "disable-image-generation": "passthrough" },
  });
}
