import { useEffect, useRef, useState } from "react";
import type { SkillInstallation, SkillScope } from "@pi-cloud/protocol";
import type { PiCloudApi } from "./api.ts";
import { useI18n } from "./i18n.tsx";
import { errorMessage } from "./ui-errors.ts";
import { SkillDetails } from "./SkillDetails.tsx";
import { SkillPublisher, type SkillDraft } from "./SkillPublisher.tsx";
import { matchesSkill, sameSkillScope, type SkillPackage } from "./skill-package-view.tsx";
export function SkillMarket({
  api,
  userId,
  owner,
  canMutate,
  projectId,
  onClose,
  onCreate,
}: {
  api: PiCloudApi;
  userId: string;
  owner: boolean;
  canMutate: boolean;
  projectId?: string;
  onClose(): void;
  onCreate(): void;
}) {
  const { language, t } = useI18n(),
    say = (cn: string, en: string) => (language === "zh-CN" ? cn : en);
  const [tab, setTab] = useState<"browse" | "installed">("browse"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const [pageStarts, setPageStarts] = useState<(string | undefined)[]>([undefined]),
    [revision, setRevision] = useState(0);
  const [packages, setPackages] = useState<SkillPackage[]>([]),
    [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>();
  const [active, setActive] = useState<SkillPackage | null>(null),
    [publishing, setPublishing] = useState<{ draft: SkillDraft | null } | null>(null);
  const [mutationError, setMutationError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPageStarts([undefined]);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const start = pageStarts.at(-1);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(undefined);
    void (async () => {
      let cursor = start;
      const seen = new Set<string>();
      while (!abort.signal.aborted) {
        const page = await api.listSkills(projectId, cursor, abort.signal);
        if (abort.signal.aborted) return;
        const visible = page.packages.filter((pack) =>
          matchesSkill(pack, search, tab === "installed"),
        );
        if (visible.length || !page.nextCursor) {
          setPackages(visible);
          setNextCursor(page.nextCursor);
          setActive((current) =>
            current
              ? (page.packages.find((pack) => pack.packageId === current.packageId) ?? current)
              : null,
          );
          return;
        }
        if (seen.has(page.nextCursor))
          throw Error(
            say("目录分页没有前进，请重试。", "Catalog pagination did not advance. Please retry."),
          );
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    })()
      .catch((cause) => {
        if (!abort.signal.aborted) setError(errorMessage(cause, t));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, projectId, start, search, tab, revision, t]);
  function refresh() {
    setRevision((v) => v + 1);
  }
  function changed(id: string, scope: SkillScope, installation: SkillInstallation | null) {
    const update = (pack: SkillPackage) =>
      pack.packageId === id
        ? {
            ...pack,
            installations: [
              ...pack.installations.filter((i) => !sameSkillScope(i.scope, scope)),
              ...(installation ? [installation] : []),
            ],
          }
        : pack;
    setPackages((current) => current.map(update));
    setActive((current) => (current ? update(current) : null));
  }
  async function install(pack: SkillPackage) {
    if (inFlight.current || !canMutate) return;
    inFlight.current = true;
    setBusy(pack.packageId);
    setMutationError(undefined);
    setNotice(undefined);
    try {
      const scope = { kind: "personal" as const };
      const installed = await api.installSkill(pack.packageId, {
        scope,
        versionId: pack.versions[0]!.versionId,
        enabled: true,
        revision: null,
      });
      if (mounted.current) {
        changed(pack.packageId, scope, installed);
        refresh();
      }
    } catch (cause) {
      if (mounted.current) {
        setMutationError(errorMessage(cause, t));
        refresh();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  return (
    <main className="skill-market">
      <header className="skill-market-header">
        <button type="button" className="skill-back" onClick={onClose}>
          ← {say("返回会话", "Back to chat")}
        </button>
        <h1>Skills</h1>
        {canMutate ? (
          <>
            <button type="button" onClick={() => setPublishing({ draft: null })}>
              {say("导入", "Import")}
            </button>
            <button type="button" className="skill-primary" onClick={onCreate}>
              ＋ {say("创建 Skill", "Create Skill")}
            </button>
          </>
        ) : null}
      </header>
      <div className="skill-market-toolbar">
        <div className="skill-tabs" role="group" aria-label={say("Skill 列表", "Skill lists")}>
          {(["browse", "installed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                setPageStarts([undefined]);
                setNotice(undefined);
              }}
            >
              {value === "browse" ? say("组织市场", "Organization") : say("已安装", "Installed")}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label={say("搜索 Skill", "Search Skills")}
          placeholder={say("搜索 Skill…", "Search Skills…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {error || mutationError ? (
        <p role="alert">
          {mutationError ?? error}{" "}
          <button
            type="button"
            onClick={() => {
              setMutationError(undefined);
              refresh();
            }}
          >
            {say("重试", "Retry")}
          </button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="skill-notice">
          {notice}
          <button
            type="button"
            aria-label={say("关闭提示", "Dismiss")}
            onClick={() => setNotice(undefined)}
          >
            ×
          </button>
        </p>
      ) : null}
      <section className="skill-cards" aria-busy={loading}>
        {loading
          ? Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="skill-card-skeleton" aria-hidden="true" />
            ))
          : packages.map((pack) => {
              const latest = pack.versions[0]!,
                enabled = pack.installations.some((i) => i.enabled),
                installed = pack.installations.length > 0,
                updates = pack.installations.some((i) => i.versionId !== latest.versionId);
              const firstInstalled =
                pack.installations.find((i) => i.scope.kind === "personal") ??
                pack.installations[0];
              const displayed =
                tab === "installed"
                  ? (pack.versions.find((v) => v.versionId === firstInstalled?.versionId) ?? latest)
                  : latest;
              return (
                <article key={pack.packageId} data-skill={latest.name}>
                  <button
                    type="button"
                    className="skill-card-content"
                    aria-label={say(`查看 ${latest.name}`, `View ${latest.name}`)}
                    onClick={() => setActive(pack)}
                  >
                    <span className="skill-card-icon" aria-hidden="true">
                      ◇
                    </span>
                    <h2>{latest.name}</h2>
                    <p>{displayed.description}</p>
                  </button>
                  <footer className="skill-card-footer">
                    <span className="skill-muted">
                      {pack.ownerUserId === userId
                        ? say("我分享的", "Shared by me")
                        : say("组织分享", "Organization")}
                    </span>
                    {installed ? (
                      <button
                        type="button"
                        className="skill-status"
                        onClick={() => setActive(pack)}
                      >
                        {updates
                          ? say("有新版本", "Update available")
                          : enabled
                            ? say("已安装", "Installed")
                            : say("已停用", "Disabled")}
                      </button>
                    ) : canMutate ? (
                      <button
                        type="button"
                        className="skill-install"
                        disabled={busy !== null}
                        onClick={() => void install(pack)}
                      >
                        {busy === pack.packageId
                          ? say("安装中…", "Installing…")
                          : say("安装", "Install")}
                      </button>
                    ) : null}
                  </footer>
                </article>
              );
            })}
      </section>
      {loading ? (
        <span role="status" className="skill-loading">
          {say("加载中…", "Loading…")}
        </span>
      ) : !packages.length && !error ? (
        <div className="skill-empty">
          <span aria-hidden="true">◇</span>
          <p>
            {pageStarts.length > 1
              ? say("没有更多匹配的 Skill", "No more matching Skills")
              : search
                ? say("没有找到匹配的 Skill", "No matching Skills")
                : tab === "installed"
                  ? say("还没有安装 Skill", "No installed Skills")
                  : say("还没有人分享 Skill", "No shared Skills yet")}
          </p>
          {tab === "installed" && !search ? (
            <button
              type="button"
              onClick={() => {
                setTab("browse");
                setPageStarts([undefined]);
              }}
            >
              {say("浏览组织市场", "Browse organization")}
            </button>
          ) : !search && canMutate ? (
            <button type="button" onClick={onCreate}>
              {say("创建 Skill", "Create Skill")}
            </button>
          ) : null}
        </div>
      ) : null}
      <nav className="skill-pagination" aria-label={say("目录分页", "Catalog pages")}>
        {pageStarts.length > 1 ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => setPageStarts((current) => current.slice(0, -1))}
          >
            {say("上一页", "Previous")}
          </button>
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => setPageStarts((current) => [...current, nextCursor])}
          >
            {say("下一页", "Next")}
          </button>
        ) : null}
      </nav>
      {active ? (
        <SkillDetails
          key={active.packageId}
          api={api}
          pack={active}
          userId={userId}
          owner={owner}
          canMutate={canMutate}
          {...(projectId ? { projectId } : {})}
          onClose={() => setActive(null)}
          onEdit={(draft) => {
            setActive(null);
            setPublishing({ draft });
          }}
          onChanged={(scope, installation) => changed(active.packageId, scope, installation)}
          onRefresh={refresh}
        />
      ) : null}
      {publishing ? (
        <SkillPublisher
          api={api}
          draft={publishing.draft}
          onClose={() => setPublishing(null)}
          onPublished={() => {
            setPublishing(null);
            setNotice(say("已分享到组织", "Shared with organization"));
            refresh();
          }}
        />
      ) : null}
    </main>
  );
}
