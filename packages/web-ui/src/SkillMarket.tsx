import { useEffect, useState } from "react";
import type {
  SkillImport,
  SkillMarket as Market,
  SkillScope,
  SkillVersion,
  SkillFile,
} from "@pi-cloud/protocol";
import { SKILL_PACKAGE_BYTES, parseSkillImport } from "@pi-cloud/protocol";
import { type PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";

const template =
  "---\nname: my-workflow\ndescription: Describe when this workflow should be used.\n---\n\n# Workflow\n\n1. Inspect the current task.\n2. Follow the project conventions.\n3. Verify the result.\n";
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function SkillMarket({
  api,
  userId,
  owner,
  canMutate,
  projectId,
  onClose,
}: {
  api: PiCloudApi;
  userId: string;
  owner: boolean;
  canMutate: boolean;
  projectId?: string;
  onClose(): void;
}) {
  const { language } = useI18n(),
    zh = language === "zh-CN";
  const say = (cn: string, en: string) => (zh ? cn : en);
  const [market, setMarket] = useState<Market>({ packages: [], nextCursor: null });
  const [cursor, setCursor] = useState<string>(),
    [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const [scopeKind, setScopeKind] = useState<SkillScope["kind"]>("personal");
  const scope: SkillScope =
    scopeKind === "project" && projectId
      ? { kind: "project", projectId }
      : { kind: scopeKind === "tenant" ? "tenant" : "personal" };
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [form, setForm] = useState(false),
    [updating, setUpdating] = useState<SkillVersion>();
  const [sourceKind, setSourceKind] = useState<"text" | "files" | "github">("text"),
    [text, setText] = useState(template);
  const [files, setFiles] = useState<SkillFile[]>([]),
    [label, setLabel] = useState("1.0");
  const [repository, setRepository] = useState(""),
    [ref, setRef] = useState("main"),
    [path, setPath] = useState("");
  const [runtime, setRuntime] = useState<"none" | "linux" | "android">("none"),
    [tools, setTools] = useState(""),
    [software, setSoftware] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    void api
      .listSkills(projectId, cursor, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setMarket(value);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [api, projectId, cursor, revision]);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(version?: SkillVersion) {
    setUpdating(version);
    setFiles([]);
    setForm(true);
    setLabel(version ? `${version.label}-next` : "1.0");
    setRuntime(version?.requirements.runtime ?? "none");
    setTools(version?.requirements.tools.join(", ") ?? "");
    setSoftware(version?.requirements.software.join(", ") ?? "");
    if (version?.source.kind === "github") {
      setSourceKind("github");
      setRepository(version.source.repository);
      setRef(version.source.ref);
      setPath(version.source.path);
    } else {
      setSourceKind(version ? "files" : "text");
      setText(template);
    }
  }
  const words = (value: string) =>
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  async function publish() {
    const source: SkillImport["source"] =
      sourceKind === "github"
        ? { kind: "github", repository, ref, path }
        : {
            kind: "files",
            files:
              sourceKind === "text"
                ? [{ path: "SKILL.md", base64: base64(new TextEncoder().encode(text)) }]
                : files,
          };
    await api.importSkill({
      ...(updating ? { packageId: updating.packageId } : {}),
      label,
      requirements: { runtime, tools: words(tools), software: words(software) },
      source,
    });
    setForm(false);
    setCursor(undefined);
  }
  async function chooseFiles(values: FileList | null) {
    if (!values) return;
    const list = [...values];
    if (list.length > 512 || list.reduce((sum, f) => sum + f.size, 0) > SKILL_PACKAGE_BYTES)
      throw new Error(
        say(
          "目录超出导入传输范围：512 个文件、16 MiB。",
          "Directory exceeds the import envelope: 512 files, 16 MiB.",
        ),
      );
    const uploaded: SkillFile[] = [];
    for (const file of list) {
      const relative = file.webkitRelativePath || file.name;
      uploaded.push({
        path: file.webkitRelativePath ? relative.split("/").slice(1).join("/") : relative,
        base64: base64(new Uint8Array(await file.arrayBuffer())),
      });
    }
    setFiles(uploaded);
  }
  return (
    <main className="skill-market">
      <header>
        <button type="button" onClick={onClose}>
          ← {say("返回会话", "Back to chat")}
        </button>
        <h1>{say("Skill 市场", "Skill market")}</h1>
        {canMutate ? (
          <button type="button" onClick={() => edit()}>
            {say("发布 Skill", "Publish Skill")}
          </button>
        ) : null}
      </header>
      <p>
        {say(
          "可复用的工作流程。安装固定版本，Agent 通过 read_skill 按需阅读。",
          "Reusable workflows. Install a version; the Agent reads it on demand with read_skill.",
        )}
      </p>
      <label>
        {say("安装范围", "Install scope")}{" "}
        <select
          value={scopeKind}
          onChange={(e) => setScopeKind(e.target.value as SkillScope["kind"])}
        >
          <option value="personal">{say("仅自己", "Personal")}</option>
          {owner ? <option value="tenant">{say("整个组织", "Organization")}</option> : null}
          {owner && projectId ? (
            <option value="project">{say("当前项目", "Current project")}</option>
          ) : null}
        </select>
      </label>
      {error ? <p role="alert">{error}</p> : null}
      {form ? (
        <form
          className="skill-publisher"
          onSubmit={(e) => {
            e.preventDefault();
            void act(publish);
          }}
        >
          <h2>
            {updating
              ? say(`更新 ${updating.name}`, `Update ${updating.name}`)
              : say("发布新 Skill", "Publish a Skill")}
          </h2>
          <label>
            {say("导入已导出的包（可选）", "Import an exported package (optional)")}
            <input
              type="file"
              accept=".json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void act(async () => {
                    if (file.size > 24 * 1024 * 1024)
                      throw new Error("Skill package exceeds its import envelope");
                    const imported = parseSkillImport(JSON.parse(await file.text()));
                    setLabel(imported.label);
                    setRuntime(imported.requirements.runtime);
                    setTools(imported.requirements.tools.join(", "));
                    setSoftware(imported.requirements.software.join(", "));
                    if (imported.source.kind === "files") {
                      setSourceKind("files");
                      setFiles(imported.source.files);
                    } else {
                      setSourceKind("github");
                      setRepository(imported.source.repository);
                      setRef(imported.source.ref);
                      setPath(imported.source.path);
                    }
                  });
              }}
            />
          </label>
          <label>
            {say("来源", "Source")}
            <select
              value={sourceKind}
              onChange={(e) => setSourceKind(e.target.value as typeof sourceKind)}
            >
              <option value="text">SKILL.md</option>
              <option value="files">{say("本地目录", "Local directory")}</option>
              <option value="github">GitHub</option>
            </select>
          </label>
          {sourceKind === "text" ? (
            <textarea
              aria-label="SKILL.md"
              rows={12}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : null}
          {sourceKind === "files" ? (
            <label>
              {say("选择包含 SKILL.md 的目录", "Choose a directory containing SKILL.md")}
              <input
                type="file"
                multiple
                ref={(element) => {
                  element?.setAttribute("webkitdirectory", "");
                }}
                onChange={(e) => {
                  void act(() => chooseFiles(e.target.files));
                }}
              />
              <small>
                {files.length} {say("个文件", "files")}
              </small>
            </label>
          ) : null}
          {sourceKind === "github" ? (
            <>
              <label>
                GitHub {say("仓库", "repository")}
                <input
                  placeholder="owner/repository"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  required
                />
              </label>
              <label>
                {say("分支、标签或提交", "Branch, tag or commit")}
                <input value={ref} onChange={(e) => setRef(e.target.value)} required />
              </label>
              <label>
                {say("Skill 目录", "Skill directory")}
                <input
                  placeholder="skills/my-skill"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
            </>
          ) : null}
          <label>
            {say("版本名称", "Version label")}
            <input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </label>
          <label>
            {say("运行环境", "Runtime requirement")}
            <select value={runtime} onChange={(e) => setRuntime(e.target.value as typeof runtime)}>
              <option value="none">{say("无环境依赖", "No environment dependency")}</option>
              <option value="linux">Linux</option>
              <option value="android">Android</option>
            </select>
          </label>
          <label>
            {say("需要的工具（逗号分隔）", "Required tools (comma separated)")}
            <input
              placeholder="bash, read"
              value={tools}
              onChange={(e) => setTools(e.target.value)}
            />
          </label>
          <label>
            {say("所需软件（运行时检查）", "Software prerequisites (checked when used)")}
            <input
              placeholder="python, ffmpeg"
              value={software}
              onChange={(e) => setSoftware(e.target.value)}
            />
          </label>
          <div>
            <button disabled={busy} type="submit">
              {busy ? say("处理中…", "Working…") : say("发布版本", "Publish version")}
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(false)}>
              {say("取消", "Cancel")}
            </button>
          </div>
        </form>
      ) : null}
      <section className="skill-cards">
        {market.packages.map((pack) => {
          const install = pack.installations.find(
            (i) =>
              i.scope.kind === scope.kind &&
              (i.scope.kind !== "project" ||
                scope.kind !== "project" ||
                i.scope.projectId === scope.projectId),
          );
          const v =
            pack.versions.find(
              (v) => v.versionId === (selected[pack.packageId] ?? install?.versionId),
            ) ?? pack.versions[0]!;
          const change = {
            scope,
            versionId: v.versionId,
            enabled: true,
            revision: install?.revision ?? null,
          };
          return (
            <article key={pack.packageId} data-skill={v.name}>
              <h2>{v.name}</h2>
              <p>{v.description}</p>
              <small>
                {v.requirements.runtime === "none"
                  ? say("无环境依赖", "No runtime dependency")
                  : v.requirements.runtime}{" "}
                · {v.requirements.tools.join(", ") || say("无必需工具", "No required tools")}
              </small>
              {v.availability.state !== "available" ? (
                <p className="skill-requirements">
                  {v.availability.state === "unsupported"
                    ? say("当前平台不支持：", "Unsupported here: ")
                    : say("所需软件待检查：", "Software not checked: ")}
                  {v.availability.reasons.join(", ")}
                </p>
              ) : null}
              {v.compatibility ? <p>{v.compatibility}</p> : null}
              <label>
                {say("版本", "Version")}
                <select
                  value={v.versionId}
                  onChange={(e) => setSelected((s) => ({ ...s, [pack.packageId]: e.target.value }))}
                >
                  {pack.versions.map((version) => (
                    <option key={version.versionId} value={version.versionId}>
                      {version.label} · {version.digest.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                {v.source.kind === "github"
                  ? `${v.source.repository} · ${v.source.commit.slice(0, 8)}`
                  : say("用户发布", "User published")}
              </small>
              <div className="skill-card-actions">
                {canMutate ? (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => void act(() => api.installSkill(pack.packageId, change))}
                    >
                      {!install
                        ? say("安装", "Install")
                        : !install.enabled
                          ? say("启用", "Enable")
                          : install.versionId !== v.versionId
                            ? say("切换版本", "Use version")
                            : say("已启用", "Enabled")}
                    </button>
                    {install?.enabled ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.installSkill(pack.packageId, {
                              ...change,
                              versionId: install.versionId,
                              enabled: false,
                            }),
                          )
                        }
                      >
                        {say("停用", "Disable")}
                      </button>
                    ) : null}
                    {install ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.uninstallSkill(pack.packageId, {
                              ...change,
                              versionId: install.versionId,
                            }),
                          )
                        }
                      >
                        {say("卸载", "Uninstall")}
                      </button>
                    ) : null}
                    {pack.ownerUserId === userId ? (
                      <button disabled={busy} onClick={() => edit(v)}>
                        {say("发布更新", "Publish update")}
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const content = await api.exportSkill(v.versionId);
                      const payload: SkillImport = {
                        label: v.label,
                        requirements: v.requirements,
                        source: { kind: "files", files: content.files },
                      };
                      const url = URL.createObjectURL(
                        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
                      );
                      const link = document.createElement("a");
                      link.href = url;
                      link.download = `${v.name}.skill.json`;
                      link.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    })
                  }
                >
                  {say("导出", "Export")}
                </button>
              </div>
            </article>
          );
        })}
      </section>
      {!market.packages.length ? (
        <p>
          {say(
            "还没有 Skill。可以发布说明文件、导入目录或 GitHub 项目中的 Skill。",
            "No Skills yet. Publish instructions or import a directory from your computer or GitHub.",
          )}
        </p>
      ) : null}
      <footer>
        {cursor ? (
          <button onClick={() => setCursor(undefined)}>{say("回到首页", "First page")}</button>
        ) : null}
        {market.nextCursor ? (
          <button onClick={() => setCursor(market.nextCursor!)}>
            {say("下一页", "Next page")}
          </button>
        ) : null}
      </footer>
    </main>
  );
}
