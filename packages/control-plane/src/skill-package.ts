import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  SKILL_PACKAGE_BYTES,
  validSkillPath,
  type SkillFile,
  type SkillImport,
  type SkillVersion,
} from "@pi-cloud/protocol";

export function skillPackage(files: readonly SkillFile[]) {
  const seen = new Set<string>();
  let total = 0;
  if (!files.length || files.length > 512) throw new TypeError("A Skill package needs 1–512 files");
  const normalized = files
    .map((file) => {
      if (!validSkillPath(file.path) || seen.has(file.path))
        throw new TypeError("Invalid or duplicate Skill path");
      seen.add(file.path);
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64)
        throw new TypeError("Invalid Skill file encoding");
      total += bytes.length;
      if (total > SKILL_PACKAGE_BYTES)
        throw new TypeError("Skill package exceeds the 16 MiB import envelope");
      return { path: file.path, base64: file.base64 };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  // Reject file/directory collisions before the package reaches a Workspace.
  for (const file of normalized) {
    const parts = file.path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join("/"))) throw new TypeError("Skill paths overlap");
    }
  }
  const main = normalized.find((file) => file.path === "SKILL.md");
  if (!main) throw new TypeError("Package root must contain SKILL.md");
  const bytes = Buffer.from(main.base64, "base64");
  if (bytes.length > 256 * 1024)
    throw new TypeError("SKILL.md is too large; move reference material into separate files");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new TypeError("SKILL.md needs YAML name and description frontmatter");
  const document = parseDocument(match[1]!);
  if (document.errors.length) throw new TypeError("Invalid Skill frontmatter");
  const metadata = document.toJS({ maxAliasCount: 32 }) as Record<string, unknown>;
  if (
    !metadata ||
    typeof metadata.name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) ||
    metadata.name.length > 64 ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim() ||
    metadata.description.length > 1024 ||
    (metadata.compatibility !== undefined &&
      (typeof metadata.compatibility !== "string" || metadata.compatibility.length > 500))
  )
    throw new TypeError("Invalid Skill name, description or compatibility");
  const content = { name: metadata.name, files: normalized };
  const body = Buffer.from(JSON.stringify(content));
  return {
    content,
    body,
    description: metadata.description,
    compatibility: (metadata.compatibility ?? "") as string,
    byteLength: total,
    digest: createHash("sha256").update(body).digest("hex"),
  };
}

/** Public GitHub import reads immutable blobs; no git hooks or package code run here. */
export async function importGitHubSkill(
  source: Extract<SkillImport["source"], { kind: "github" }>,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ files: SkillFile[]; source: SkillVersion["source"] }> {
  if (source.path && !validSkillPath(source.path))
    throw new TypeError("Invalid repository directory");
  const root = `https://api.github.com/repos/${source.repository}`;
  const get = async (path: string) => {
    const response = await fetcher(root + path, {
      signal,
      redirect: "error",
      headers: { accept: "application/vnd.github+json", "user-agent": "PiCloud-Skill-import" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub Skill import returned HTTP ${response.status}`);
    }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 24 * 1024 * 1024) throw new Error("GitHub import response is too large");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const commit = (await get(`/commits/${encodeURIComponent(source.ref)}`)) as {
    sha?: string;
    commit?: { tree?: { sha?: string } };
  };
  if (!/^[a-f0-9]{40}$/.test(commit.sha ?? "") || !commit.commit?.tree?.sha)
    throw new Error("GitHub did not resolve the Skill revision");
  let treeId = commit.commit.tree.sha;
  for (const part of source.path.split("/").filter(Boolean)) {
    const tree = await get(`/git/trees/${treeId}`);
    const dir = tree.tree.find(
      (entry: { path: string; type: string }) => entry.path === part && entry.type === "tree",
    );
    if (!dir) throw new TypeError("Skill directory was not found at that revision");
    treeId = dir.sha;
  }
  const tree = await get(`/git/trees/${treeId}?recursive=1`);
  if (tree.truncated || !Array.isArray(tree.tree))
    throw new TypeError("Skill tree exceeds the import envelope");
  const entries = tree.tree.filter((entry: { type: string }) => entry.type !== "tree");
  if (
    entries.length > 512 ||
    entries.some(
      (entry: { mode: string; size: number; path: string }) =>
        !["100644", "100755"].includes(entry.mode) || !validSkillPath(entry.path),
    ) ||
    entries.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0) >
      SKILL_PACKAGE_BYTES
  )
    throw new TypeError(
      "Skill import requires bounded regular files, without symlinks or submodules",
    );
  const files: SkillFile[] = [];
  for (const entry of entries) {
    const blob = await get(`/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64") throw new TypeError("Unsupported Git blob encoding");
    files.push({ path: entry.path, base64: blob.content.replace(/\s/g, "") });
  }
  return { files, source: { ...source, commit: commit.sha! } };
}
