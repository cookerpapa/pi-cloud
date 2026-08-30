import { useEffect, useState, type FormEvent } from "react";
import type {
  AuthenticationConfigurationResource,
  TenantIdentityResource,
} from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { errorMessage } from "./ui-errors.ts";
import { LanguageSelect, useI18n } from "./i18n.tsx";

type AuthMode = "login" | "register";

export function AuthScreen({
  api,
  onAuthenticated,
}: {
  api: PiCloudApi;
  onAuthenticated: (identity: TenantIdentityResource) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configuration, setConfiguration] = useState<AuthenticationConfigurationResource | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .getAuthenticationConfiguration()
      .then((value) => {
        if (cancelled) return;
        setConfiguration(value);
        if (!value.local.registration) setMode("login");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught, t));
      });
    return () => {
      cancelled = true;
    };
  }, [api, t]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session =
        mode === "login"
          ? await api.loginAccount(username.trim().toLowerCase(), password)
          : await api.registerAccount(username.trim().toLowerCase(), displayName.trim(), password);
      onAuthenticated(session.identity);
    } catch (caught: unknown) {
      setError(errorMessage(caught, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-auth-page">
      <div className="product-auth-language">
        <LanguageSelect />
      </div>
      <section className="product-auth-brand">
        <h1>PiCloud</h1>
      </section>
      <form className="product-auth-card" onSubmit={(event) => void submit(event)}>
        {configuration?.local.login === false ? null : (
          <>
            <div className="product-auth-tabs" role="tablist" aria-label={t("auth.accountActions")}>
              <button
                aria-selected={mode === "login"}
                className={mode === "login" ? "active" : ""}
                onClick={() => {
                  setMode("login");
                  setError(null);
                }}
                role="tab"
                type="button"
              >
                {t("auth.login")}
              </button>
              {configuration?.local.registration === false ? null : (
                <button
                  aria-selected={mode === "register"}
                  className={mode === "register" ? "active" : ""}
                  onClick={() => {
                    setMode("register");
                    setError(null);
                  }}
                  role="tab"
                  type="button"
                >
                  {t("auth.register")}
                </button>
              )}
            </div>
            <h2>{mode === "login" ? t("auth.welcomeBack") : t("auth.createAccount")}</h2>
            {mode === "register" ? (
              <label>
                <span>{t("auth.displayName")}</span>
                <input
                  autoComplete="name"
                  maxLength={256}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t("auth.displayNamePlaceholder")}
                  required
                  value={displayName}
                />
              </label>
            ) : null}
            <label>
              <span>{t("auth.username")}</span>
              <input
                autoCapitalize="none"
                autoComplete="username"
                maxLength={48}
                minLength={3}
                onChange={(event) => setUsername(event.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,47}"
                placeholder={t("auth.usernamePlaceholder")}
                required
                spellCheck={false}
                value={username}
              />
            </label>
            <label>
              <span>{t("auth.password")}</span>
              <input
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                maxLength={128}
                minLength={10}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("auth.passwordPlaceholder")}
                required
                type="password"
                value={password}
              />
            </label>
            {error ? <div className="product-auth-error">{error}</div> : null}
            <button className="product-primary-button" disabled={busy} type="submit">
              {busy
                ? t("auth.pleaseWait")
                : mode === "login"
                  ? t("auth.login")
                  : t("auth.registerContinue")}
            </button>
          </>
        )}
      </form>
    </main>
  );
}
