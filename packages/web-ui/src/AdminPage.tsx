import { useEffect, useState } from "react";
import type {
  CubeProxyConfigurationResource,
  DeepSeekModelId,
  ModelConfigurationResource,
  TenantIdentityResource,
} from "@pi-cloud/protocol";
import { PiCloudApiError, type PiCloudApi } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";
import { LanguageSelect, useI18n } from "./i18n.tsx";

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
  const [selectedModelId, setSelectedModelId] = useState<DeepSeekModelId>("deepseek-v4-flash");
  const [modelApiKey, setModelApiKey] = useState("");
  const [cubeProxyConfiguration, setCubeProxyConfiguration] =
    useState<CubeProxyConfigurationResource | null>(null);
  const [cubeProxyEnabled, setCubeProxyEnabled] = useState(false);
  const [cubeProxyUrl, setCubeProxyUrl] = useState("");
  const [settingsSaving, setSettingsSaving] = useState<"model" | "proxy" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getCubeProxyConfiguration(), api.getModelConfiguration()])
      .then(([proxyConfiguration, model]) => {
        if (cancelled) return;
        setCubeProxyConfiguration(proxyConfiguration);
        setCubeProxyEnabled(proxyConfiguration.enabled);
        setCubeProxyUrl(proxyConfiguration.proxyUrl ?? "");
        setModelConfiguration(model);
        if (model.mode === "real") setSelectedModelId(model.modelId);
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
  }, [api]);

  async function saveModelConfiguration(): Promise<void> {
    if (modelConfiguration === null || settingsSaving !== null) return;
    const apiKey = modelApiKey.trim();
    if (!/^[A-Za-z0-9._-]{16,512}$/.test(apiKey)) {
      setError(t("admin.invalidApiKey"));
      return;
    }
    setSettingsSaving("model");
    setError(null);
    try {
      const configured = await api.replaceModelConfiguration(selectedModelId, apiKey);
      setModelConfiguration(configured);
      setModelApiKey("");
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
        <div>
          <span>{identity.displayName}</span>
          <LanguageSelect compact />
          <button onClick={onLogout} type="button">
            {t("admin.logout")}
          </button>
        </div>
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
                onChange={(event) => setSelectedModelId(event.target.value as DeepSeekModelId)}
                value={selectedModelId}
              >
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
              </select>
            </label>
            <label>
              <span>API Key</span>
              <input
                autoComplete="off"
                disabled={settingsSaving !== null}
                onChange={(event) => setModelApiKey(event.target.value)}
                placeholder={modelConfiguration?.mode === "real" ? t("admin.rotateKey") : "sk-…"}
                spellCheck={false}
                type="password"
                value={modelApiKey}
              />
            </label>
            <div className="product-settings-action">
              <small>
                {t("admin.credentialVersion", {
                  version:
                    modelConfiguration === null
                      ? t("common.loading")
                      : String(modelConfiguration.credentialVersion),
                })}
              </small>
              <button
                className="product-primary-button"
                disabled={
                  settingsSaving !== null ||
                  modelApiKey.trim() === "" ||
                  modelConfiguration === null
                }
                onClick={() => void saveModelConfiguration()}
                type="button"
              >
                {settingsSaving === "model" ? t("admin.encrypting") : t("admin.updateModel")}
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
      </section>
    </main>
  );
}
