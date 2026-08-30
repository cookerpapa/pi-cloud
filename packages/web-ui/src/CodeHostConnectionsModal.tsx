import { useEffect, useState } from "react";
import type { CodeHostConnectionResource } from "@pi-cloud/protocol";
import { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";

export function CodeHostConnectionsModal(props: {
  api: PiCloudApi;
  workspaceId: string;
  workspaceName: string;
  defaultProvider?: "github" | "gitlab";
  defaultOrigin?: string;
  onClose(): void;
  onConnected?(): void;
}) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<readonly CodeHostConnectionResource[]>([]);
  const [provider, setProvider] = useState<"github" | "gitlab">(props.defaultProvider ?? "gitlab");
  const [origin, setOrigin] = useState(
    props.defaultOrigin ?? (props.defaultProvider === "github" ? "https://github.com" : ""),
  );
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true);
    void props.api
      .codeHostConnections(props.workspaceId)
      .then((result) => {
        if (active) setConnections(result.connections);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorMessage(failure, t));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [props.api, props.workspaceId, t]);

  return (
    <div className="product-modal-backdrop" role="presentation">
      <form
        className="product-workspace-modal product-code-host-modal"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError(null);
          void props.api
            .connectCodeHost(props.workspaceId, {
              provider,
              origin: origin.trim(),
              accessToken: token,
            })
            .then((result) => {
              setConnections(result.connections);
              setToken("");
              props.onConnected?.();
            })
            .catch((failure: unknown) => setError(errorMessage(failure, t)))
            .finally(() => setBusy(false));
        }}
      >
        <header>
          <div>
            <h2>{t("codeHost.title")}</h2>
            <small>{props.workspaceName}</small>
          </div>
          <button onClick={props.onClose} type="button">
            ×
          </button>
        </header>

        <section className="product-code-host-connections">
          <h3>{t("codeHost.connected")}</h3>
          {connections.length === 0 ? (
            <small>{t("codeHost.empty")}</small>
          ) : (
            connections.map((connection) => (
              <div
                className="product-code-host-connection"
                key={`${connection.provider}:${connection.origin}`}
              >
                <span>
                  <strong>{connection.provider === "github" ? "GitHub" : "GitLab"}</strong>
                  <small>{connection.origin}</small>
                </span>
                <button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void props.api
                      .disconnectCodeHost(props.workspaceId, connection)
                      .then((result) => setConnections(result.connections))
                      .catch((failure: unknown) => setError(errorMessage(failure, t)))
                      .finally(() => setBusy(false));
                  }}
                  type="button"
                >
                  {t("codeHost.disconnect")}
                </button>
              </div>
            ))
          )}
        </section>

        <label>
          <span>{t("codeHost.provider")}</span>
          <select
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as "github" | "gitlab";
              setProvider(next);
              if (next === "github") setOrigin("https://github.com");
            }}
            value={provider}
          >
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </select>
        </label>
        <label>
          <span>{t("codeHost.origin")}</span>
          <input
            disabled={busy || provider === "github"}
            onChange={(event) => setOrigin(event.target.value)}
            placeholder="https://gitlab.company.com"
            required
            type="url"
            value={origin}
          />
        </label>
        <label>
          <span>{t("codeHost.token")}</span>
          <input
            autoComplete="off"
            disabled={busy}
            minLength={16}
            onChange={(event) => setToken(event.target.value)}
            required
            type="password"
            value={token}
          />
          <small>
            {provider === "gitlab" ? t("codeHost.gitlabHelp") : t("codeHost.githubHelp")}
          </small>
        </label>
        {error === null ? null : <div className="product-form-error">{error}</div>}
        <div className="product-workspace-modal-actions">
          <button onClick={props.onClose} type="button">
            {t("common.cancel")}
          </button>
          <button
            className="product-primary-button"
            disabled={busy || token.length < 16}
            type="submit"
          >
            {busy ? t("codeHost.connecting") : t("codeHost.connect")}
          </button>
        </div>
      </form>
    </div>
  );
}
