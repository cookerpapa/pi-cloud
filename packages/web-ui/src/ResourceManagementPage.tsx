import { useMemo, useState } from "react";
import type {
  ConversationSummaryResource,
  DevelopmentEnvironmentListResource,
  DevelopmentEnvironmentProfileKey,
  DevelopmentEnvironmentResource,
  WorkspaceSummaryResource,
} from "@pi-cloud/protocol";
import { newIdempotencyKey, PiCloudApi } from "./api.ts";

const ACTIVE_SESSION_STATES = new Set(["starting", "running", "waiting_approval", "cancelling"]);

const ENVIRONMENT_STATE_LABELS: Readonly<Record<string, string>> = {
  creating: "创建中",
  running: "运行中",
  paused: "已暂停",
  failed: "异常",
  released: "已释放",
};

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
  const [tab, setTab] = useState<"workspaces" | "environments">("workspaces");
  const [profileKey, setProfileKey] = useState<DevelopmentEnvironmentProfileKey>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveEnvironments = environments.filter((environment) => environment.state !== "released");
  const elasticWorkspaces = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          !environments.some((environment) => environment.workspaceId === workspace.workspaceId),
      ),
    [environments, workspaces],
  );
  const selectedProfile = profiles.find((candidate) => candidate.key === profileKey) ?? profiles[0];

  async function mutate(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await onRefresh();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "资源操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="product-resource-page">
      <div className="product-resource-shell">
        <header className="product-resource-header">
          <button className="product-resource-back" onClick={onClose} type="button">
            <span aria-hidden="true">←</span> 对话
          </button>
          <h1>资源</h1>
          <div className="product-resource-summary" aria-label="资源概览">
            <span>
              <strong>{String(elasticWorkspaces.length)}</strong> Workspace
            </span>
            <span>
              <strong>{String(liveEnvironments.length)}</strong> 独享环境
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
            独享环境 <span>{String(liveEnvironments.length)}</span>
          </button>
        </nav>
        {error === null ? null : <div className="product-form-error">{error}</div>}

        {tab === "workspaces" ? (
          <section className="product-resource-section">
            {elasticWorkspaces.length === 0 ? (
              <div className="product-resource-empty">暂无 Workspace</div>
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
                            <span>{String(linked.length)} 个对话</span>
                          </div>
                        </div>
                        <span className={`product-resource-status${active ? " active" : ""}`}>
                          {active ? "使用中" : "可用"}
                        </span>
                      </header>
                      <dl className="product-resource-metadata">
                        <div>
                          <dt>最近规格</dt>
                          <dd>
                            {workspaceProfile === undefined
                              ? "—"
                              : `${String(workspaceProfile.cpuCount)}C · ${String(
                                  workspaceProfile.memoryMiB / 1024,
                                )}G · ${String(workspaceProfile.systemDiskGiB)}G`}
                          </dd>
                        </div>
                        <div>
                          <dt>文件状态</dt>
                          <dd>已持久化</dd>
                        </div>
                      </dl>
                      {linked.length === 0 ? null : (
                        <div className="product-resource-links">
                          <span className="product-resource-links-label">关联对话</span>
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
                                `永久删除 Workspace“${workspace.name}”及其中的文件？关联对话会保留并等待重新绑定。`,
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
                          删除
                        </button>
                        {active ? <small>Agent 正在运行</small> : null}
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
                <h2>申请独享环境</h2>
                {selectedProfile === undefined ? null : <span>{selectedProfile.label}</span>}
              </header>
              <form
                className="product-resource-create product-environment-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate(() =>
                    api.createDevelopmentEnvironment(profileKey, newIdempotencyKey("environment")),
                  );
                }}
              >
                <label>
                  <span>CPU</span>
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
                        {String(profile.cpuCount)} 核
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>内存</span>
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
                  <span>系统盘</span>
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
                  disabled={busy || selectedProfile === undefined}
                  type="submit"
                >
                  {busy ? "处理中…" : "申请"}
                </button>
              </form>
            </div>

            {liveEnvironments.length === 0 ? (
              <div className="product-resource-empty">暂无独享环境</div>
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
                            <h3>{environment.environmentId.slice(0, 8)}</h3>
                            <span>
                              {String(environment.cpuCount)}C ·{" "}
                              {String(environment.memoryMiB / 1024)}G ·{" "}
                              {String(environment.systemDiskGiB)}G
                            </span>
                          </div>
                        </div>
                        <span className={`product-resource-status ${environment.state}`}>
                          {ENVIRONMENT_STATE_LABELS[environment.state] ?? environment.state}
                        </span>
                      </header>
                      <dl className="product-resource-metadata">
                        <div>
                          <dt>IP 地址</dt>
                          <dd>{environment.ipAddress ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>关联对话</dt>
                          <dd>{String(linked.length)}</dd>
                        </div>
                      </dl>
                      {linked.length === 0 ? null : (
                        <div className="product-resource-links">
                          <span className="product-resource-links-label">工作目录</span>
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
                            暂停
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
                            恢复
                          </button>
                        ) : null}
                        {environment.state === "failed" ? (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void mutate(() =>
                                api.developmentEnvironmentAction(
                                  environment.environmentId,
                                  "start",
                                  newIdempotencyKey("environment"),
                                ),
                              )
                            }
                            type="button"
                          >
                            重建
                          </button>
                        ) : null}
                        <button
                          className="product-danger-button"
                          disabled={busy || active}
                          onClick={() => {
                            if (!window.confirm("释放这台独享环境？对话会保留。")) return;
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
                          释放
                        </button>
                        {active ? <small>Agent 正在运行</small> : null}
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
