import { useEffect, useState } from "react";
import type {
  ConversationSummaryResource,
  DevelopmentEnvironmentListResource,
  DevelopmentEnvironmentProfileKey,
  DevelopmentEnvironmentResource,
  WorkspaceSummaryResource,
  SourceControlConfigurationResource,
  SourceControlIssueJobResource,
} from "@pi-cloud/protocol";
import { newIdempotencyKey, PiCloudApi, PiCloudApiError } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { WorkspaceDirectoryPicker } from "./WorkspaceDirectoryPicker.tsx";

const ACTIVE_SESSION_STATES = new Set([
  "starting",
  "running",
  "cancelling",
  "recovering",
  "evicting",
]);

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
  initialTab = "workspaces",
  onClose,
  onRefresh,
  profiles,
  workspaces,
}: {
  api: PiCloudApi;
  conversations: readonly ConversationSummaryResource[];
  environments: readonly DevelopmentEnvironmentResource[];
  initialTab?: "workspaces" | "environments" | "source-control";
  onClose: () => void;
  onRefresh: () => Promise<void>;
  profiles: DevelopmentEnvironmentListResource["profiles"];
  workspaces: readonly WorkspaceSummaryResource[];
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"workspaces" | "environments" | "source-control">(initialTab);
  const [profileKey, setProfileKey] = useState<DevelopmentEnvironmentProfileKey>("standard");
  const [machineName, setMachineName] = useState("");
  const [gitlabBaseUrl, setGitlabBaseUrl] = useState("http://gitlab.localhost:8929");
  const [gitlabProject, setGitlabProject] = useState("");
  const [gitlabToken, setGitlabToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceControl, setSourceControl] = useState<SourceControlConfigurationResource | null>(
    null,
  );
  const [issueJobs, setIssueJobs] = useState<readonly SourceControlIssueJobResource[]>([]);
  const [issueStartJobId, setIssueStartJobId] = useState<string | null>(null);
  const [issueExecutionMode, setIssueExecutionMode] = useState<
    "elastic" | "development_environment"
  >("elastic");
  const [issueProfileKey, setIssueProfileKey] =
    useState<DevelopmentEnvironmentProfileKey>("standard");
  const [issueEnvironmentId, setIssueEnvironmentId] = useState("");
  const [issueWorkingDirectory, setIssueWorkingDirectory] = useState("/home/user");
  const [issueDirectoryPickerOpen, setIssueDirectoryPickerOpen] = useState(false);
  const liveEnvironments = environments;
  const elasticWorkspaces = workspaces;
  const selectedProfile = profiles.find((candidate) => candidate.key === profileKey) ?? profiles[0];
  const issueStartJob = issueJobs.find((job) => job.jobId === issueStartJobId);

  function replaceIssueJob(updated: SourceControlIssueJobResource): void {
    setIssueJobs((current) => current.map((job) => (job.jobId === updated.jobId ? updated : job)));
  }

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

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSourceControl(), api.listSourceControlIssueJobs()])
      .then(([configuration, jobs]) => {
        if (cancelled) return;
        setSourceControl(configuration);
        setIssueJobs(jobs.jobs);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : t("resource.operationFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [api, t]);

  useEffect(() => {
    if (
      tab !== "source-control" ||
      !issueJobs.some((job) => !["completed", "failed", "cancelled"].includes(job.state))
    ) {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .listSourceControlIssueJobs()
        .then((jobs) => {
          if (!cancelled) setIssueJobs(jobs.jobs);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, issueJobs, tab]);

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
          <button
            className={tab === "source-control" ? "active" : ""}
            onClick={() => setTab("source-control")}
            type="button"
          >
            GitLab{" "}
            <span>
              {String(
                sourceControl?.installations.filter(
                  (installation) => installation.provider === "gitlab",
                ).length ?? 0,
              )}
            </span>
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
        ) : tab === "source-control" ? (
          <section className="product-resource-section product-source-control-section">
            <div className="product-resource-provisioner">
              <header>
                <h2>{t("sourceControl.title")}</h2>
                <span>{t("sourceControl.gitlabProject")}</span>
              </header>
              <form
                className="product-resource-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(async () => {
                    setSourceControl(
                      await api.connectGitLabProject({
                        baseUrl: gitlabBaseUrl,
                        project: gitlabProject,
                        accessToken: gitlabToken,
                      }),
                    );
                    setGitlabToken("");
                  });
                }}
              >
                <label>
                  <span>{t("sourceControl.gitlabUrl")}</span>
                  <input
                    onChange={(event) => setGitlabBaseUrl(event.target.value)}
                    required
                    type="url"
                    value={gitlabBaseUrl}
                  />
                </label>
                <label>
                  <span>{t("sourceControl.gitlabProjectPath")}</span>
                  <input
                    onChange={(event) => setGitlabProject(event.target.value)}
                    placeholder="group/project"
                    required
                    value={gitlabProject}
                  />
                </label>
                <label>
                  <span>{t("sourceControl.gitlabToken")}</span>
                  <input
                    autoComplete="off"
                    onChange={(event) => setGitlabToken(event.target.value)}
                    required
                    type="password"
                    value={gitlabToken}
                  />
                </label>
                <button
                  className="product-primary-button"
                  disabled={busy || sourceControl?.gitlabConfigured !== true}
                  type="submit"
                >
                  {t("sourceControl.connect")}
                </button>
                {sourceControl?.gitlabConfigured === false ? (
                  <small>{t("sourceControl.notConfigured")}</small>
                ) : null}
              </form>
            </div>
            {(sourceControl?.installations.filter(
              (installation) => installation.provider === "gitlab",
            ).length ?? 0) === 0 ? (
              <div className="product-resource-empty">{t("sourceControl.empty")}</div>
            ) : (
              <div className="product-resource-grid">
                {sourceControl!.installations
                  .filter((installation) => installation.provider === "gitlab")
                  .map((installation) => (
                    <article className="product-resource-card" key={installation.installationId}>
                      <header>
                        <div className="product-resource-card-title">
                          <span className="product-resource-kind">GL</span>
                          <div>
                            <h3>{installation.accountLogin}</h3>
                            <span>{installation.accountType}</span>
                          </div>
                        </div>
                        <span
                          className={`product-resource-status${installation.state === "active" ? " active" : ""}`}
                        >
                          {installation.state}
                        </span>
                      </header>
                      <div className="product-resource-links">
                        <span className="product-resource-links-label">
                          {t("sourceControl.repositories", {
                            count: installation.repositories.filter(
                              (repository) => repository.state === "active",
                            ).length,
                          })}
                        </span>
                        {installation.repositories
                          .filter((repository) => repository.state === "active")
                          .map((repository) => (
                            <span key={repository.repositoryId}>
                              {repository.fullName}
                              {repository.private ? " · private" : ""}
                            </span>
                          ))}
                      </div>
                      <div className="product-resource-actions">
                        <button
                          disabled={busy}
                          onClick={() => {
                            void mutate(async () => {
                              setSourceControl(
                                await api.refreshSourceControlInstallation(
                                  installation.installationId,
                                ),
                              );
                            });
                          }}
                          type="button"
                        >
                          {t("sourceControl.refresh")}
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
            )}
            {issueJobs.length === 0 ? null : (
              <div className="product-resource-provisioner product-issue-jobs">
                <header>
                  <h2>{t("sourceControl.issueJobs")}</h2>
                </header>
                <div className="product-issue-job-list">
                  {issueJobs.map((job) => (
                    <article className="product-issue-job" key={job.jobId}>
                      <header>
                        <div>
                          <strong>
                            {job.repositoryFullName} #{String(job.issueNumber)}
                          </strong>
                          <span>{job.issueTitle}</span>
                        </div>
                        <span className="product-resource-status">{job.state}</span>
                      </header>
                      <div className="product-issue-claims">
                        <small>{t("sourceControl.claims")}</small>
                        {job.claims.length === 0 ? (
                          <span>{t("sourceControl.noClaims")}</span>
                        ) : (
                          job.claims.map((claim) => (
                            <span key={claim.userId}>@{claim.username}</span>
                          ))
                        )}
                      </div>
                      <div className="product-resource-actions">
                        {job.state === "awaiting_claim" && job.claimEligible ? (
                          <button
                            disabled={busy}
                            onClick={() => {
                              void mutate(async () => {
                                replaceIssueJob(
                                  job.claimedByCurrentUser
                                    ? await api.unclaimSourceControlIssueJob(job.jobId)
                                    : await api.claimSourceControlIssueJob(job.jobId),
                                );
                              });
                            }}
                            type="button"
                          >
                            {job.claimedByCurrentUser
                              ? t("sourceControl.unclaim")
                              : t("sourceControl.claim")}
                          </button>
                        ) : null}
                        {job.state === "awaiting_claim" && !job.claimEligible ? (
                          <small>{t("sourceControl.gitlabLoginRequired")}</small>
                        ) : null}
                        {job.state === "awaiting_claim" && job.claimedByCurrentUser ? (
                          <button
                            className="product-primary-button"
                            disabled={busy}
                            onClick={() => {
                              setIssueStartJobId(job.jobId);
                              setIssueExecutionMode("elastic");
                              setIssueProfileKey("standard");
                              setIssueEnvironmentId(liveEnvironments[0]?.environmentId ?? "");
                              setIssueWorkingDirectory("/home/user");
                            }}
                            type="button"
                          >
                            {t("sourceControl.start")}
                          </button>
                        ) : null}
                        <a href={job.issueUrl} rel="noreferrer" target="_blank">
                          Issue ↗
                        </a>
                        {job.changeRequestUrl === undefined ? null : (
                          <a href={job.changeRequestUrl} rel="noreferrer" target="_blank">
                            MR ↗
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
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
      {issueStartJob === undefined ? null : (
        <div className="product-modal-backdrop" role="presentation">
          <form
            className="product-workspace-modal product-issue-start-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(async () => {
                const updated = await api.startSourceControlIssueJob(
                  issueStartJob.jobId,
                  issueExecutionMode === "elastic"
                    ? {
                        executionMode: "elastic",
                        sandboxProfileKey: issueProfileKey,
                      }
                    : {
                        executionMode: "development_environment",
                        developmentEnvironmentId: issueEnvironmentId,
                        workingDirectory: issueWorkingDirectory,
                      },
                );
                replaceIssueJob(updated);
                setIssueStartJobId(null);
              });
            }}
          >
            <header>
              <div>
                <h2>{t("sourceControl.startTitle")}</h2>
                <small>
                  {issueStartJob.repositoryFullName} #{String(issueStartJob.issueNumber)}
                </small>
              </div>
              <button onClick={() => setIssueStartJobId(null)} type="button">
                ×
              </button>
            </header>
            <label>
              <span>{t("sourceControl.executionMode")}</span>
              <select
                onChange={(event) =>
                  setIssueExecutionMode(event.target.value as "elastic" | "development_environment")
                }
                value={issueExecutionMode}
              >
                <option value="elastic">{t("chat.elastic")}</option>
                <option value="development_environment">{t("resource.exclusive")}</option>
              </select>
            </label>
            {issueExecutionMode === "elastic" ? (
              <label>
                <span>{t("sourceControl.profile")}</span>
                <select
                  onChange={(event) =>
                    setIssueProfileKey(event.target.value as DevelopmentEnvironmentProfileKey)
                  }
                  value={issueProfileKey}
                >
                  {profiles.map((profile) => (
                    <option key={profile.key} value={profile.key}>
                      {profile.label} · {String(profile.cpuCount)}C · {String(profile.memoryMiB)}MiB
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  <span>{t("resource.exclusive")}</span>
                  <select
                    onChange={(event) => setIssueEnvironmentId(event.target.value)}
                    required
                    value={issueEnvironmentId}
                  >
                    <option value="">{t("chat.create.selectExclusive")}</option>
                    {liveEnvironments
                      .filter((environment) => environment.state === "running")
                      .map((environment) => (
                        <option key={environment.environmentId} value={environment.environmentId}>
                          {environment.workspaceName}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>{t("sourceControl.workingDirectory")}</span>
                  <div className="product-directory-field">
                    <input readOnly value={issueWorkingDirectory} />
                    <button
                      disabled={issueEnvironmentId.length === 0}
                      onClick={() => setIssueDirectoryPickerOpen(true)}
                      type="button"
                    >
                      {t("chat.create.chooseDirectory")}
                    </button>
                  </div>
                  <small>{t("sourceControl.workingDirectoryHelp")}</small>
                </label>
              </>
            )}
            <div className="product-workspace-modal-actions">
              <button onClick={() => setIssueStartJobId(null)} type="button">
                {t("common.cancel")}
              </button>
              <button
                className="product-primary-button"
                disabled={
                  busy ||
                  (issueExecutionMode === "development_environment" &&
                    (issueEnvironmentId.length === 0 ||
                      !issueWorkingDirectory.startsWith("/home/user/")))
                }
                type="submit"
              >
                {t("sourceControl.start")}
              </button>
            </div>
          </form>
        </div>
      )}
      {issueDirectoryPickerOpen && issueEnvironmentId.length > 0 ? (
        <WorkspaceDirectoryPicker
          api={api}
          environmentId={issueEnvironmentId}
          initialDirectory={issueWorkingDirectory}
          onCancel={() => setIssueDirectoryPickerOpen(false)}
          onChoose={(directory) => {
            setIssueWorkingDirectory(directory);
            setIssueDirectoryPickerOpen(false);
          }}
          workspaceName={
            liveEnvironments.find((environment) => environment.environmentId === issueEnvironmentId)
              ?.workspaceName ?? "GitLab Issue"
          }
        />
      ) : null}
    </main>
  );
}
