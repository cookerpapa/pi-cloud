export const MANAGEMENT_SERVICES = [
  "providerGateway",
  "grafana",
  "prometheus",
  "alertmanager",
  "jaeger",
] as const;

export type ManagementService = (typeof MANAGEMENT_SERVICES)[number];

export interface WebConfiguration {
  productUrl: string;
  adminUrl: string;
  managementUrls: Record<ManagementService, string>;
}

function httpUrl(value: unknown, optional = false): string {
  if (optional && value === "") return "";
  if (typeof value !== "string") throw new Error("Web configuration requires HTTP URLs");
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error("Web configuration requires credential-free HTTP URLs");
  }
  return url.href;
}

export async function loadWebConfiguration(
  fetcher: typeof fetch = fetch,
): Promise<WebConfiguration> {
  const response = await fetcher("/ui-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Web configuration returned HTTP ${response.status}`);
  const value = (await response.json()) as WebConfiguration;
  const productUrl = httpUrl(value.productUrl);
  const adminUrl = httpUrl(value.adminUrl);
  for (const entry of [productUrl, adminUrl]) {
    const url = new URL(entry);
    if (url.pathname !== "/" || url.search || url.hash) {
      throw new Error("Product and administrator URLs must be origins, not paths");
    }
  }
  return {
    productUrl,
    adminUrl,
    managementUrls: Object.fromEntries(
      MANAGEMENT_SERVICES.map((key) => [key, httpUrl(value.managementUrls[key], true)]),
    ) as WebConfiguration["managementUrls"],
  };
}

export function identityDestination(
  configuration: WebConfiguration,
  administrator: boolean,
  currentOrigin: string,
): string | null {
  const target = administrator ? configuration.adminUrl : configuration.productUrl;
  return new URL(target).origin === currentOrigin ? null : target;
}
