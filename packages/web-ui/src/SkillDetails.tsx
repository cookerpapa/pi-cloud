import { useEffect, useState } from "react";
import type { SkillInstallation, SkillPackageContent, SkillScope } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import type { PiCloudApiError } from "@pi-cloud/session-client";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";
import { Markdown } from "./Markdown.tsx";
import { SkillDialog } from "./SkillDialog.tsx";
import {
  downloadSkill,
  skillBody,
  skillBytes,
  skillInstallation,
  skillText,
  type SkillPackage,
} from "./skill-package-view.tsx";
import type { SkillDraft } from "./SkillPublisher.tsx";
export function SkillDetails({
  api,
  pack,
  userId,
  owner,
  canMutate,
  projectId,
  onClose,
  onEdit,
  onChanged,
  onRefresh,
}: {
  api: PiCloudApi;
  pack: SkillPackage;
  userId: string;
  owner: boolean;
  canMutate: boolean;
  projectId?: string;
  onClose(): void;
  onEdit(draft: SkillDraft): void;
  onChanged(scope: SkillScope, installation: SkillInstallation | null): void;
  onRefresh(): void;
}) {
  const { language, t } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const defaultInstall =
    pack.installations.find((i) => i.scope.kind === "personal") ?? pack.installations[0];
  const [scope, setScope] = useState<SkillScope>(defaultInstall?.scope ?? { kind: "personal" });
  const [versionId, setVersionId] = useState(
    defaultInstall?.versionId ?? pack.versions[0]!.versionId,
  );
  const version = pack.versions.find((v) => v.versionId === versionId) ?? pack.versions[0]!,
    installation = skillInstallation(pack, scope);
  const [tab, setTab] = useState<"overview" | "files">("overview"),
    [filePath, setFilePath] = useState("SKILL.md");
  const [loaded, setLoaded] = useState<{ id: string; content: SkillPackageContent }>(),
    [readError, setReadError] = useState<string>(),
    [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const allowed = canMutate && (scope.kind === "personal" || owner),
    content = loaded?.id === version.versionId ? loaded.content : undefined;
  useEffect(() => {
    let current = true;
    setReadError(undefined);
    void api
      .exportSkill(version.versionId)
      .then((value) => {
        if (current) setLoaded({ id: version.versionId, content: value });
      })
      .catch((cause) => {
        if (current) setReadError(errorMessage(cause, t));
      });
    return () => {
      current = false;
    };
  }, [api, version.versionId, retry, t]);
  async function change(action: "install" | "disable" | "uninstall") {
    if (busy || !allowed) return;
    setBusy(true);
    setError(undefined);
    try {
      const request = {
        scope,
        versionId: action === "install" ? version.versionId : installation!.versionId,
        enabled: action !== "disable",
        revision: installation?.revision ?? null,
      };
      if (action === "uninstall") {
        await api.uninstallSkill(pack.packageId, request);
        onChanged(scope, null);
      } else onChanged(scope, await api.installSkill(pack.packageId, request));
      onRefresh();
    } catch (cause) {
      setError(
        (cause as PiCloudApiError)?.status === 409
          ? say("内容已更新，请重试。", "This item changed. Please retry.")
          : errorMessage(cause, t),
      );
      onRefresh();
    } finally {
      setBusy(false);
    }
  }
  const file = content?.files.find((f) => f.path === (tab === "overview" ? "SKILL.md" : filePath));
  const text = file ? skillText(file) : null,
    preview = text === null ? null : (tab === "overview" ? skillBody(text) : text).slice(0, 65536);
  const same = installation?.versionId === version.versionId && installation.enabled;
  return (
    <SkillDialog title={version.name} busy={busy} onClose={onClose}>
      <div className="skill-detail-body">
        <p className="skill-detail-description">{version.description}</p>
        <div className="skill-install-bar">
          <label>
            {say("使用范围", "Scope")}
            <select
              aria-label={say("使用范围", "Scope")}
              disabled={busy}
              value={scope.kind}
              onChange={(event) => {
                const kind = event.target.value as SkillScope["kind"];
                const next: SkillScope =
                  kind === "project" ? { kind, projectId: projectId! } : { kind };
                setScope(next);
                setFilePath("SKILL.md");
                setVersionId(
                  skillInstallation(pack, next)?.versionId ?? pack.versions[0]!.versionId,
                );
              }}
            >
              <option value="personal">{say("仅自己", "Personal")}</option>
              <option value="tenant">{say("整个组织", "Organization")}</option>
              {projectId ? (
                <option value="project">{say("当前项目", "Current project")}</option>
              ) : null}
            </select>
          </label>
          <label>
            {say("版本", "Version")}
            <select
              aria-label={say("版本", "Version")}
              disabled={busy}
              value={version.versionId}
              onChange={(event) => {
                setVersionId(event.target.value);
                setFilePath("SKILL.md");
              }}
            >
              {pack.versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  {v.label}
                  {v.versionId === pack.versions[0]!.versionId ? say(" · 最新", " · Latest") : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="skill-primary"
            disabled={busy || !allowed || same}
            onClick={() => void change("install")}
          >
            {busy
              ? say("保存中…", "Saving…")
              : same
                ? say("已启用", "Enabled")
                : installation?.versionId === version.versionId
                  ? say("启用", "Enable")
                  : installation
                    ? say("使用此版本", "Use version")
                    : say("安装", "Install")}
          </button>
          {installation?.enabled && allowed ? (
            <button disabled={busy} type="button" onClick={() => void change("disable")}>
              {say("停用", "Disable")}
            </button>
          ) : null}
          <details className="skill-more">
            <summary>{say("更多", "More")}</summary>
            <div>
              {canMutate && pack.ownerUserId === userId ? (
                <button
                  disabled={busy || !content}
                  type="button"
                  onClick={() => content && onEdit({ version, content })}
                >
                  {say("导入新版本", "Import new version")}
                </button>
              ) : null}
              <button
                disabled={busy || !content}
                type="button"
                onClick={() =>
                  content &&
                  downloadSkill(
                    `${version.name}.skill.json`,
                    JSON.stringify(
                      {
                        label: version.label,
                        requirements: version.requirements,
                        source: { kind: "files", files: content.files },
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                {say("导出", "Export")}
              </button>
              {installation && allowed ? (
                <button type="button" disabled={busy} onClick={() => void change("uninstall")}>
                  {say("卸载", "Uninstall")}
                </button>
              ) : null}
            </div>
          </details>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {version.requirements.runtime !== "none" ||
        version.requirements.tools.length ||
        version.requirements.software.length ||
        version.compatibility ? (
          <details className="skill-advanced">
            <summary>
              {say("运行要求", "Requirements")}
              {version.availability.state === "unsupported" ? (
                <span className="skill-status">{say("当前环境不适用", "Not supported here")}</span>
              ) : null}
            </summary>
            <dl>
              {version.requirements.runtime !== "none" ? (
                <>
                  <dt>{say("环境", "Runtime")}</dt>
                  <dd>{version.requirements.runtime}</dd>
                </>
              ) : null}
              {version.requirements.tools.length ? (
                <>
                  <dt>{say("工具", "Tools")}</dt>
                  <dd>{version.requirements.tools.join(", ")}</dd>
                </>
              ) : null}
              {version.requirements.software.length ? (
                <>
                  <dt>{say("软件", "Software")}</dt>
                  <dd>{version.requirements.software.join(", ")}</dd>
                </>
              ) : null}
            </dl>
            {version.compatibility ? <p>{version.compatibility}</p> : null}
          </details>
        ) : null}
        <div className="skill-tabs" role="group" aria-label={say("Skill 内容", "Skill content")}>
          <button
            type="button"
            aria-pressed={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            {say("说明", "Overview")}
          </button>
          <button type="button" aria-pressed={tab === "files"} onClick={() => setTab("files")}>
            {say("文件", "Files")}
          </button>
        </div>
        {readError ? (
          <p role="alert">
            {readError}{" "}
            <button type="button" onClick={() => setRetry((v) => v + 1)}>
              {say("重试", "Retry")}
            </button>
          </p>
        ) : !content ? (
          <p role="status" className="skill-muted">
            {say("加载中…", "Loading…")}
          </p>
        ) : (
          <>
            {tab === "files" ? (
              <div className="skill-file-toolbar">
                <select
                  aria-label={say("文件", "File")}
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                >
                  {content.files.map((f) => (
                    <option key={f.path} value={f.path}>
                      {f.path}
                    </option>
                  ))}
                </select>
                {file ? (
                  <button
                    type="button"
                    onClick={() =>
                      downloadSkill(
                        file.path.split("/").at(-1)!,
                        new Uint8Array(skillBytes(file)).buffer,
                      )
                    }
                  >
                    {say("下载", "Download")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {preview !== null ? (
              <div className="skill-preview">
                {tab === "overview" ? <Markdown>{preview}</Markdown> : <pre>{preview}</pre>}
              </div>
            ) : (
              <p className="skill-muted">
                {say("此文件不提供文本预览", "No text preview available")}
              </p>
            )}
            {text && text.length > 65536 ? (
              <p className="skill-muted">
                {say(
                  "内容较长，可在文件页下载完整版。",
                  "Long content preview. Download the full version from Files.",
                )}
              </p>
            ) : null}
          </>
        )}
      </div>
    </SkillDialog>
  );
}
