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
      <header className="product-resource-header">
        <div>
          <span>PiCloud</span>
          <h1>开发资源</h1>
          <p>Workspace 保存文件；独享运行环境保存进程、服务与终端状态。</p>
        </div>
        <button onClick={onClose} type="button">
          返回对话
        </button>
      </header>
      <nav className="product-resource-tabs">
        <button
          className={tab === "workspaces" ? "active" : ""}
          onClick={() => setTab("workspaces")}
          type="button"
        >
          Workspaces
        </button>
        <button
          className={tab === "environments" ? "active" : ""}
          onClick={() => setTab("environments")}
          type="button"
        >
          独享运行环境
        </button>
      </nav>
      {error === null ? null : <div className="product-form-error">{error}</div>}

      {tab === "workspaces" ? (
        <section className="product-resource-section">
          <p className="product-resource-boundary-note">
            Workspace 只在“弹性执行”新建对话时创建；这里用于查看文件资源、规格和关联对话。
          </p>
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
                    <div>
                      <h3>{workspace.name}</h3>
                      <span>{String(linked.length)} 个关联对话</span>
                    </div>
                    <span className="product-resource-status">持久文件</span>
                  </header>
                  <p>
                    最近沙箱规格：
                    {workspaceProfile === undefined
                      ? "尚未运行"
                      : `${String(workspaceProfile.cpuCount)}C/${String(
                          workspaceProfile.memoryMiB / 1024,
                        )}G/${String(workspaceProfile.systemDiskGiB)}G`}
                  </p>
                  <div className="product-resource-links">
                    {linked.length === 0 ? (
                      <span>暂无关联对话</span>
                    ) : (
                      linked.map((conversation) => (
                        <span key={conversation.sessionId}>
                          {conversation.title} · {conversation.state}
                        </span>
                      ))
                    )}
                  </div>
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
                        api.deleteWorkspace(workspace.workspaceId, newIdempotencyKey("delete")),
                      );
                    }}
                    type="button"
                  >
                    删除 Workspace
                  </button>
                  {active ? <small>有 Agent Run 正在执行，暂时不能删除。</small> : null}
                </article>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="product-resource-section">
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
              <span>CPU 核数</span>
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
              <span>内存大小</span>
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
              <span>磁盘大小</span>
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
              申请环境
            </button>
          </form>
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
                    <div>
                      <h3>独享环境 {environment.environmentId.slice(0, 8)}</h3>
                      <span>
                        {String(environment.cpuCount)}C · {String(environment.memoryMiB / 1024)}G
                        内存 · {String(environment.systemDiskGiB)}G 系统盘
                      </span>
                    </div>
                    <span className={`product-resource-status ${environment.state}`}>
                      {environment.state}
                    </span>
                  </header>
                  <p>IP 地址：{environment.ipAddress ?? "等待 Cube 分配"}</p>
                  <div className="product-resource-links">
                    {linked.length === 0 ? (
                      <span>暂无关联对话</span>
                    ) : (
                      linked.map((conversation) => (
                        <span key={conversation.sessionId}>
                          {conversation.title} · {conversation.workingDirectory}
                        </span>
                      ))
                    )}
                  </div>
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
                        if (
                          !window.confirm(
                            "释放这台独享 Cube？Workspace 文件和对话会保留，后台进程会停止。",
                          )
                        )
                          return;
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
                      释放环境
                    </button>
                  </div>
                  {active ? <small>有 Agent Run 正在执行，环境操作已锁定。</small> : null}
                </article>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
