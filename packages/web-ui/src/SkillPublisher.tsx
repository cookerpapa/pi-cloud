import { useRef, useState } from "react";
import {
  SKILL_PACKAGE_BYTES,
  parseSkillImport,
  type SkillFile,
  type SkillVersion,
  type SkillPackageContent,
  type SkillImport,
} from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";
import { SkillDialog } from "./SkillDialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { skillBase64, skillText, skillBody } from "./skill-package-view.tsx";
export type SkillDraft = { version: SkillVersion; content: SkillPackageContent };
export function SkillPublisher({
  api,
  draft,
  onClose,
  onPublished,
}: {
  api: PiCloudApi;
  draft: SkillDraft | null;
  onClose(): void;
  onPublished(version: SkillVersion): void;
}) {
  const { language, t } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const [text, setText] = useState(() =>
    draft?.content.files.find((f) => f.path === "SKILL.md")
      ? (skillText(draft.content.files.find((f) => f.path === "SKILL.md")!) ?? "")
      : "",
  );
  const [files, setFiles] = useState<SkillFile[]>(draft?.content.files ?? []),
    [label, setLabel] = useState(draft ? `${draft.version.label}-next` : "1.0");
  const [runtime, setRuntime] = useState(draft?.version.requirements.runtime ?? "none"),
    [tools, setTools] = useState(draft?.version.requirements.tools.join(", ") ?? ""),
    [software, setSoftware] = useState(draft?.version.requirements.software.join(", ") ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const importing = useRef(false);
  const words = (value: string) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  async function importLocal(values: FileList | null, packageFile = false) {
    if (!values?.length || importing.current) return;
    importing.current = true;
    setBusy(true);
    setError(undefined);
    try {
      let next: SkillFile[];
      let metadata: SkillImport | undefined;
      if (packageFile) {
        const file = values[0]!;
        if (file.size > 24 * 1024 * 1024) throw Error(say("文件过大", "File too large"));
        const input = parseSkillImport(JSON.parse(await file.text()));
        if (input.source.kind !== "files")
          throw Error(
            say("请选择包含本地文件的 Skill 包", "Choose a Skill package containing local files"),
          );
        next = input.source.files;
        metadata = input;
      } else {
        if (
          values.length > 512 ||
          [...values].reduce((sum, f) => sum + f.size, 0) > SKILL_PACKAGE_BYTES
        )
          throw Error(say("目录最多 512 个文件、16 MiB", "Directory limit: 512 files, 16 MiB"));
        next = await Promise.all(
          [...values].map(async (file) => ({
            path: file.webkitRelativePath
              ? file.webkitRelativePath.split("/").slice(1).join("/")
              : file.name,
            base64: skillBase64(new Uint8Array(await file.arrayBuffer())),
          })),
        );
      }
      const main = next.find((f) => f.path === "SKILL.md"),
        body = main ? skillText(main) : null;
      if (body === null)
        throw Error(say("目录中需要 UTF-8 格式的 SKILL.md", "A UTF-8 SKILL.md is required"));
      if (metadata) {
        setLabel(metadata.label);
        setRuntime(metadata.requirements.runtime);
        setTools(metadata.requirements.tools.join(", "));
        setSoftware(metadata.requirements.software.join(", "));
      }
      setFiles(next);
      setText(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : errorMessage(cause, t));
    } finally {
      setBusy(false);
      importing.current = false;
    }
  }
  async function publish() {
    if (importing.current) return;
    importing.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const input: SkillImport = {
        ...(draft ? { packageId: draft.version.packageId } : {}),
        label,
        requirements: { runtime, tools: words(tools), software: words(software) },
        source: {
          kind: "files",
          files,
        },
      };
      const version = await api.importSkill(parseSkillImport(input));
      onPublished(version);
    } catch (cause) {
      setError(errorMessage(cause, t));
    } finally {
      setBusy(false);
      importing.current = false;
    }
  }
  return (
    <SkillDialog
      title={
        draft ? say("导入新版本", "Import a new version") : say("导入 Skill", "Import a Skill")
      }
      busy={busy}
      onClose={onClose}
    >
      <form
        className="skill-publisher"
        onSubmit={(event) => {
          event.preventDefault();
          void publish();
        }}
      >
        <div className="skill-import-options">
          <label className="skill-file-picker">
            {say("选择目录", "Choose directory")}
            <input
              aria-label={say("选择目录", "Choose directory")}
              disabled={busy}
              type="file"
              multiple
              ref={(node) => node?.setAttribute("webkitdirectory", "")}
              onChange={(event) => void importLocal(event.target.files)}
            />
          </label>
          <label className="skill-file-picker">
            {say("选择 Skill 包", "Choose Skill package")}
            <input
              aria-label={say("选择 Skill 包", "Choose Skill package")}
              disabled={busy}
              type="file"
              accept=".json"
              onChange={(event) => void importLocal(event.target.files, true)}
            />
          </label>
          {files.length ? (
            <p className="skill-muted">{say(`${files.length} 个文件`, `${files.length} files`)}</p>
          ) : null}
        </div>
        {text ? (
          <details className="skill-advanced">
            <summary>{say("查看 SKILL.md", "Preview SKILL.md")}</summary>
            <div className="skill-preview">
              <Markdown>{skillBody(text).slice(0, 65536)}</Markdown>
            </div>
          </details>
        ) : null}
        {files.length > 1 ? (
          <span className="skill-muted">
            {say(`附带 ${files.length - 1} 个文件`, `${files.length - 1} supporting files`)}
          </span>
        ) : null}
        <details className="skill-advanced">
          <summary>{say("版本与运行要求", "Version and requirements")}</summary>
          <label>
            {say("版本", "Version")}
            <input
              aria-label={say("版本名称", "Version label")}
              value={label}
              required
              disabled={busy}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            {say("运行环境", "Runtime")}
            <select
              value={runtime}
              disabled={busy}
              onChange={(event) => setRuntime(event.target.value as typeof runtime)}
            >
              <option value="none">{say("不限", "Any")}</option>
              <option value="linux">Linux</option>
              {runtime === "android" ? <option value="android">Android</option> : null}
            </select>
          </label>
          <label>
            {say("需要的工具", "Required tools")}
            <input
              value={tools}
              disabled={busy}
              placeholder="bash, read"
              onChange={(event) => setTools(event.target.value)}
            />
          </label>
          <label>
            {say("所需软件", "Required software")}
            <input
              value={software}
              disabled={busy}
              placeholder="python, ffmpeg"
              onChange={(event) => setSoftware(event.target.value)}
            />
          </label>
        </details>
        {error ? <p role="alert">{error}</p> : null}
        <footer className="skill-dialog-footer">
          <button type="button" disabled={busy} onClick={onClose}>
            {say("取消", "Cancel")}
          </button>
          <button
            type="submit"
            className="skill-primary"
            disabled={busy || !text.trim() || !files.length}
          >
            {busy ? say("保存中…", "Saving…") : say("分享到组织", "Share with organization")}
          </button>
        </footer>
      </form>
    </SkillDialog>
  );
}
