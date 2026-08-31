import { useEffect, useMemo, useState } from "react";
import type {
  CubeProxyConfigurationResource,
  ModelConfigurationResource,
  ProviderModelSelection,
  TenantIdentityResource,
} from "@pi-cloud/protocol";
import { PiCloudApiError, type PiCloudApi } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";
import { useI18n } from "./i18n.tsx";
import { AccountMenu } from "./AccountMenu.tsx";

const MODEL_OPTIONS: readonly (ProviderModelSelection & { label: string })[] = [
  { provider: "openai-codex", modelId: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { provider: "openai-codex", modelId: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { provider: "openai-codex", modelId: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { provider: "deepseek", modelId: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { provider: "deepseek", modelId: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

function selectionKey(selection: ProviderModelSelection): string {
  return `${selection.provider}:${selection.modelId}`;
}

function plainSelection(selection: ProviderModelSelection): ProviderModelSelection {
  return selection.provider === "deepseek"
    ? { provider: "deepseek", modelId: selection.modelId }
    : { provider: "openai-codex", modelId: selection.modelId };
}

function operatorUrl(port: number, path = "/"): string {
  const url = new URL(
    typeof window === "undefined" ? "http://127.0.0.1:8081/" : window.location.href,
  );
  url.port = String(port);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function AdminPage({
  api,
  identity,
  onLogout,
}: {
  api: PiCloudApi;
  identity: TenantIdentityResource;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const [modelConfiguration, setModelConfiguration] = useState<ModelConfigurationResource | null>(
    null,
  );
  const [selectedModel, setSelectedModel] = useState<ProviderModelSelection>({
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
  });
  const [cubeProxyConfiguration, setCubeProxyConfiguration] =
    useState<CubeProxyConfigurationResource | null>(null);
  const [cubeProxyEnabled, setCubeProxyEnabled] = useState(false);
  const [cubeProxyUrl, setCubeProxyUrl] = useState("");
  const [settingsSaving, setSettingsSaving] = useState<"model" | "proxy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const managementLinks = useMemo(
    () => [
      {
        title: t("admin.providerGateway"),
        description: t("admin.providerGatewayDescription"),
        href: operatorUrl(8318, "/management.html"),
      },
      { title: "Grafana", description: t("admin.grafanaDescription"), href: operatorUrl(3001) },
      {
        title: "Prometheus",
        description: t("admin.prometheusDescription"),
        href: operatorUrl(9090),
      },
      {
        title: "Alertmanager",
        description: t("admin.alertmanagerDescription"),
        href: operatorUrl(9093),
      },
      { title: "Jaeger", description: t("admin.jaegerDescription"), href: operatorUrl(16686) },
    ],
    [t],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getCubeProxyConfiguration(), api.getModelConfiguration()])
      .then(([proxyConfiguration, model]) => {
        if (cancelled) return;
        setCubeProxyConfiguration(proxyConfiguration);
        setCubeProxyEnabled(proxyConfiguration.enabled);
        setCubeProxyUrl(proxyConfiguration.proxyUrl ?? "");
        setModelConfiguration(model);
        if (model.mode === "real") {
          setSelectedModel(plainSelection(model));
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof PiCloudApiError && caught.status === 403) {
          setCubeProxyConfiguration(null);
          setModelConfiguration(null);
          return;
        }
        setError(errorMessage(caught, t));
      });
    return () => {
      cancelled = true;
    };
  }, [api, t]);

  async function saveModelConfiguration(): Promise<void> {
    if (modelConfiguration === null || settingsSaving !== null) return;
    setSettingsSaving("model");
    setError(null);
    try {
      setModelConfiguration(await api.replaceModelConfiguration(selectedModel));
    } catch (caught: unknown) {
      setError(errorMessage(caught, t));
    } finally {
      setSettingsSaving(null);
    }
  }

  async function saveCubeProxyConfiguration(): Promise<void> {
    if (cubeProxyConfiguration === null || settingsSaving !== null) return;
    const proxyUrl = cubeProxyUrl.trim();
    if (cubeProxyEnabled && proxyUrl.length === 0) {
      setError(t("admin.proxyRequired"));
      return;
    }
    setSettingsSaving("proxy");
    setError(null);
    try {
      const configured = await api.replaceCubeProxyConfiguration(
        cubeProxyEnabled,
        proxyUrl.length === 0 ? undefined : proxyUrl,
      );
      setCubeProxyConfiguration(configured);
      setCubeProxyEnabled(configured.enabled);
      setCubeProxyUrl(configured.proxyUrl ?? "");
    } catch (caught: unknown) {
      setError(errorMessage(caught, t));
    } finally {
      setSettingsSaving(null);
    }
  }

  return (
    <main className="product-admin-page">
      <header className="product-admin-header">
        <div>
          <div>
            <strong>{t("admin.title")}</strong>
            <span>{t("admin.subtitle")}</span>
          </div>
        </div>
        <AccountMenu label={identity.username ?? identity.displayName} onLogout={onLogout} />
      </header>
      {error ? (
        <div className="product-error-banner product-admin-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            ×
          </button>
        </div>
      ) : null}
      <section className="product-admin-content">
        <div className="product-admin-intro">
          <span>{t("admin.administration")}</span>
          <h1>{t("admin.runtimeConfiguration")}</h1>
          <p>{t("admin.runtimeDescription")}</p>
        </div>
        <div className="product-admin-grid">
          <section className="product-settings-section">
            <div>
              <h2>{t("admin.workerModel")}</h2>
              <p>{t("admin.workerModelDescription")}</p>
            </div>
            <label>
              <span>{t("admin.model")}</span>
              <select
                disabled={settingsSaving !== null}
                onChange={(event) => {
                  const selected = MODEL_OPTIONS.find(
                    (candidate) => selectionKey(candidate) === event.target.value,
                  );
                  if (selected !== undefined) {
                    setSelectedModel(plainSelection(selected));
                  }
                }}
                value={selectionKey(selectedModel)}
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={selectionKey(option)} value={selectionKey(option)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="product-settings-action">
              <small>
                {t("admin.routeVersion", {
                  version:
                    modelConfiguration === null
                      ? t("common.loading")
                      : String(modelConfiguration.routeVersion),
                })}
              </small>
              <button
                className="product-primary-button"
                disabled={settingsSaving !== null || modelConfiguration === null}
                onClick={() => void saveModelConfiguration()}
                type="button"
              >
                {settingsSaving === "model" ? t("admin.publishing") : t("admin.updateModel")}
              </button>
            </div>
          </section>
          <section className="product-settings-section">
            <div>
              <h2>{t("admin.proxy")}</h2>
              <p>{t("admin.proxyDescription")}</p>
            </div>
            <label className="product-settings-toggle">
              <input
                checked={cubeProxyEnabled}
                disabled={settingsSaving !== null}
                onChange={(event) => setCubeProxyEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>{t("admin.proxyToggle")}</span>
            </label>
            <label>
              <span>{t("admin.upstreamProxy")}</span>
              <input
                autoComplete="off"
                disabled={settingsSaving !== null}
                onChange={(event) => setCubeProxyUrl(event.target.value)}
                placeholder="http://127.0.0.1:7890"
                spellCheck={false}
                type="url"
                value={cubeProxyUrl}
              />
            </label>
            <div className="product-settings-action">
              <small>
                {t("admin.proxyVersion", {
                  version:
                    cubeProxyConfiguration === null
                      ? t("common.loading")
                      : String(cubeProxyConfiguration.revision),
                })}
              </small>
              <button
                className="product-primary-button"
                disabled={
                  settingsSaving !== null ||
                  cubeProxyConfiguration === null ||
                  (cubeProxyEnabled && cubeProxyUrl.trim() === "")
                }
                onClick={() => void saveCubeProxyConfiguration()}
                type="button"
              >
                {settingsSaving === "proxy" ? t("admin.publishing") : t("admin.applyProxy")}
              </button>
            </div>
          </section>
        </div>
        <section className="product-admin-services">
          <div>
            <h2>{t("admin.services")}</h2>
            <p>{t("admin.servicesDescription")}</p>
          </div>
          <div className="product-admin-service-grid">
            {managementLinks.map((service) => (
              <a href={service.href} key={service.title} rel="noreferrer" target="_blank">
                <strong>{service.title}</strong>
                <span>{service.description}</span>
                <small>{t("admin.openService")} ↗</small>
              </a>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
