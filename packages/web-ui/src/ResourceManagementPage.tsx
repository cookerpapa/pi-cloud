import { useEffect, useState } from "react";
import type {
  ConversationSummaryResource,
  DevelopmentEnvironmentListResource,
  DevelopmentEnvironmentProfileKey,
  DevelopmentEnvironmentResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { newIdempotencyKey, PiCloudApi, PiCloudApiError } from "./api.ts";
import { useI18n } from "./i18n.tsx";

const ACTIVE_SESSION_STATES = new Set(["starting", "running", "waiting_approval", "cancelling"]);

function associations(
  conversations: readonly ConversationSummaryResource[],
  workspaceId: string,
): readonly ConversationSummaryResource[] {
  return conversations.filter((conversation) => conversation.workspaceId === workspaceId);
}

function activeConversation(
  conversations: readonly ConversationSummaryResource[],
  workspaceId: string,
): boolean {
  return associations(conversations, workspaceId).some((conversation) =>
    ACTIVE_SESSION_STATES.has(conversation.state),
  );
}

export function resourceRefreshPending(
  environments: readonly DevelopmentEnvironmentResource[],
): boolean {
  return environments.some((environment) =>
    ["requested", "provisioning", "releasing"].includes(environment.state),
  );
}

export function ResourceManagementPage({
  api,
  conversations,
  environments,
  onClose,
  onRefresh,
  profiles,
  workspaces,
}: {
  api: PiCloudApi;
  conversations: readonly ConversationSummaryResource[];
  environments: readonly DevelopmentEnvironmentResource[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  profiles: DevelopmentEnvironmentListResource["profiles"];
  workspaces: readonly WorkspaceSummaryResource[];
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"workspaces" | "environments">("workspaces");
  const [profileKey, setProfileKey] = useState<DevelopmentEnvironmentProfileKey>("standard");
  const [machineName, setMachineName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveEnvironments = environments;
  const elasticWorkspaces = workspaces;
  const selectedProfile = profiles.find((candidate) => candidate.key === profileKey) ?? profiles[0];

  useEffect(() => {
    if (!resourceRefreshPending(environments)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      await onRefresh().catch(() => undefined);
      if (!cancelled) timer = setTimeout(() => void refresh(), 750);
    };
    timer = setTimeout(() => void refresh(), 750);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [environments, onRefresh]);

  async function mutate(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (reason: unknown) {
      setError(
        reason instanceof PiCloudApiError && reason.code === "capacity_exhausted"
          ? t("resource.capacityUnavailable")
          : reason instanceof PiCloudApiError && reason.code === "tenant_quota_exceeded"
            ? t("resource.quotaExceeded")
            : reason instanceof Error
              ? reason.message
              : t("resource.operationFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-resource-page">
      <div className="product-resource-shell">
        <header className="product-resource-header">
          <button className="product-resource-back" onClick={onClose} type="button">
            <span aria-hidden="true">←</span> {t("common.conversation")}
          </button>
          <h1>{t("resource.title")}</h1>
          <div className="product-resource-summary" aria-label={t("resource.summary")}>
            <span>
              <strong>{String(elasticWorkspaces.length)}</strong> Workspace
            </span>
            <span>
              <strong>{String(liveEnvironments.length)}</strong> {t("resource.exclusive")}
            </span>
          </div>
        </header>

        <nav className="product-resource-tabs">
          <button
            className={tab === "workspaces" ? "active" : ""}
            onClick={() => setTab("workspaces")}
            type="button"
          >
            Workspace <span>{String(elasticWorkspaces.length)}</span>
          </button>
          <button
            className={tab === "environments" ? "active" : ""}
            onClick={() => setTab("environments")}
            type="button"
          >
            {t("resource.exclusive")} <span>{String(liveEnvironments.length)}</span>
          </button>
        </nav>
        {error === null ? null : <div className="product-form-error">{error}</div>}

        {tab === "workspaces" ? (
          <section className="product-resource-section">
            {elasticWorkspaces.length === 0 ? (
              <div className="product-resource-empty">{t("resource.emptyWorkspace")}</div>
            ) : (
              <div className="product-resource-grid">
                {elasticWorkspaces.map((workspace) => {
                  const linked = associations(conversations, workspace.workspaceId);
                  const workspaceProfile = profiles.find(
                    (profile) => profile.key === linked[0]?.sandboxProfileKey,
                  );
                  const active = activeConversation(conversations, workspace.workspaceId);
                  return (
                    <article key={workspace.workspaceId} className="product-resource-card">
                      <header>
                        <div className="product-resource-card-title">
                          <span className="product-resource-kind">W</span>
                          <div>
                            <h3>{workspace.name}</h3>
                            <span>
                              {t("resource.workspaceConversations", { count: linked.length })}
                            </span>
                          </div>
                        </div>
                        <span className={`product-resource-status${active ? " active" : ""}`}>
                          {active ? t("resource.inUse") : t("common.available")}
                        </span>
                      </header>
                      <dl className="product-resource-metadata">
                        <div>
                          <dt>{t("resource.latestProfile")}</dt>
                          <dd>
                            {workspaceProfile === undefined
                              ? "—"
                              : `${String(workspaceProfile.cpuCount)}C · ${String(
                                  workspaceProfile.memoryMiB / 1024,
                                )}G · ${String(workspaceProfile.systemDiskGiB)}G`}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("resource.fileState")}</dt>
                          <dd>{t("resource.persisted")}</dd>
                        </div>
                      </dl>
                      {linked.length === 0 ? null : (
                        <div className="product-resource-links">
                          <span className="product-resource-links-label">
                            {t("resource.relatedConversations")}
                          </span>
                          {linked.map((conversation) => (
                            <span key={conversation.sessionId}>{conversation.title}</span>
                          ))}
                        </div>
                      )}
                      <div className="product-resource-actions">
                        <button
                          className="product-danger-button"
                          disabled={busy || active}
                          onClick={() => {
                            if (
                              !window.confirm(
                                t("resource.deleteWorkspaceConfirm", { name: workspace.name }),
                              )
                            )
                              return;
                            void mutate(() =>
                              api.deleteWorkspace(
                                workspace.workspaceId,
                                newIdempotencyKey("delete"),
                              ),
                            );
                          }}
                          type="button"
                        >
                          {t("common.delete")}
                        </button>
                        {active ? <small>{t("resource.agentRunning")}</small> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ) : (
          <section className="product-resource-section">
            <div className="product-resource-provisioner">
              <header>
                <h2>{t("resource.createExclusive")}</h2>
                {selectedProfile === undefined ? null : <span>{selectedProfile.label}</span>}
              </header>
              <form
                className="product-resource-create product-environment-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = machineName.trim();
                  if (name.length === 0) {
                    setError(t("resource.machineNameRequired"));
                    return;
                  }
                  void mutate(() =>
                    api
                      .createDevelopmentEnvironment(
                        name,
                        profileKey,
                        newIdempotencyKey("environment"),
                      )
                      .then((result) => {
                        setMachineName("");
                        return result;
                      }),
                  );
                }}
              >
                <label>
                  <span>{t("resource.machineName")}</span>
                  <input
                    maxLength={64}
                    onChange={(event) => setMachineName(event.target.value)}
                    placeholder={t("resource.machineNamePlaceholder")}
                    required
                    value={machineName}
                  />
                </label>
                <label>
                  <span>{t("resource.cpu")}</span>
                  <select
                    onChange={(event) => {
                      const cpu = Number(event.target.value);
                      const candidate = profiles.find((profile) => profile.cpuCount === cpu);
                      if (candidate !== undefined) setProfileKey(candidate.key);
                    }}
                    value={selectedProfile?.cpuCount ?? 1}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.key} value={profile.cpuCount}>
                        {t("resource.cores", { count: profile.cpuCount })}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("resource.memory")}</span>
                  <select
                    onChange={(event) => {
                      const memory = Number(event.target.value);
                      const candidate = profiles.find((profile) => profile.memoryMiB === memory);
                      if (candidate !== undefined) setProfileKey(candidate.key);
                    }}
                    value={selectedProfile?.memoryMiB ?? 2_048}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.key} value={profile.memoryMiB}>
                        {String(profile.memoryMiB / 1024)} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("resource.systemDisk")}</span>
                  <select
                    onChange={(event) => {
                      const disk = Number(event.target.value);
                      const candidate = profiles.find((profile) => profile.systemDiskGiB === disk);
                      if (candidate !== undefined) setProfileKey(candidate.key);
                    }}
                    value={selectedProfile?.systemDiskGiB ?? 8}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.key} value={profile.systemDiskGiB}>
                        {String(profile.systemDiskGiB)} GB
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="product-primary-button"
                  disabled={
                    busy || selectedProfile === undefined || machineName.trim().length === 0
                  }
                  type="submit"
                >
                  {busy ? t("common.processing") : t("resource.apply")}
                </button>
              </form>
            </div>

            {liveEnvironments.length === 0 ? (
              <div className="product-resource-empty">{t("resource.emptyExclusive")}</div>
            ) : (
              <div className="product-resource-grid">
                {liveEnvironments.map((environment) => {
                  const linked = associations(conversations, environment.workspaceId);
                  const active = activeConversation(conversations, environment.workspaceId);
                  return (
                    <article
                      key={environment.environmentId}
                      className="product-resource-card product-environment-card"
                    >
                      <header>
                        <div className="product-resource-card-title">
                          <span className="product-resource-kind">VM</span>
                          <div>
                            <h3>{environment.workspaceName}</h3>
                            <span>
                              {String(environment.cpuCount)}C ·{" "}
                              {String(environment.memoryMiB / 1024)}G ·{" "}
                              {String(environment.systemDiskGiB)}G
                            </span>
                          </div>
                        </div>
                        <span className={`product-resource-status ${environment.state}`}>
                          {t(`resource.state.${environment.state}` as const)}
                        </span>
                      </header>
                      <dl className="product-resource-metadata">
                        <div>
                          <dt>{t("resource.ip")}</dt>
                          <dd>{environment.ipAddress ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>{t("resource.relatedConversations")}</dt>
                          <dd>{String(linked.length)}</dd>
                        </div>
                      </dl>
                      {linked.length === 0 ? null : (
                        <div className="product-resource-links">
                          <span className="product-resource-links-label">
                            {t("resource.workingDirectory")}
                          </span>
                          {linked.map((conversation) => (
                            <span key={conversation.sessionId}>
                              {conversation.title} · {conversation.workingDirectory}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="product-resource-actions">
                        {environment.state === "running" ? (
                          <button
                            disabled={busy || active}
                            onClick={() =>
                              void mutate(() =>
                                api.developmentEnvironmentAction(
                                  environment.environmentId,
                                  "pause",
                                  newIdempotencyKey("environment"),
                                ),
                              )
                            }
                            type="button"
                          >
                            {t("resource.pause")}
                          </button>
                        ) : null}
                        {environment.state === "paused" ? (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void mutate(() =>
                                api.developmentEnvironmentAction(
                                  environment.environmentId,
                                  "resume",
                                  newIdempotencyKey("environment"),
                                ),
                              )
                            }
                            type="button"
                          >
                            {t("resource.resume")}
                          </button>
                        ) : null}
                        <button
                          className="product-danger-button"
                          disabled={busy || active}
                          onClick={() => {
                            if (!window.confirm(t("resource.releaseConfirm"))) return;
                            void mutate(() =>
                              api.developmentEnvironmentAction(
                                environment.environmentId,
                                "release",
                                newIdempotencyKey("environment"),
                              ),
                            );
                          }}
                          type="button"
                        >
                          {t("resource.release")}
                        </button>
                        {active ? <small>{t("resource.agentRunning")}</small> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
