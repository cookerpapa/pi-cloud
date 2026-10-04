// Reproducible source inventory for the October 4 review; no runtime mutation.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";

const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const files = [],
  workspaces = new Map(),
  imports = [];
for (const path of paths) {
  const bytes = await readFile(path);
  const source = bytes.toString("utf8");
  const workspace = /^packages\/([^/]+)\//.exec(path)?.[1];
  const kind = path.includes("/src/migrations/")
    ? "historical_migration"
    : path.startsWith("docs/reports/")
      ? "historical_evidence"
      : /\/(test|tests)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
        ? "test"
        : /^packages\/[^/]+\/src\//.test(path)
          ? "runtime"
          : path.startsWith("deploy/cubesandbox/patches/")
            ? "native_patch"
            : /^(deploy|scripts|\.github)\//.test(path) || /Dockerfile/.test(path)
              ? "delivery"
              : /\.md$/.test(path)
                ? "documentation"
                : "configuration_or_asset";
  const entry = {
    path,
    kind,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (!bytes.includes(0)) entry.lines = source.split("\n").length;
  if (workspace) {
    if (!workspaces.has(workspace))
      workspaces.set(workspace, {
        name: workspace,
        runtimeFiles: 0,
        runtimeLines: 0,
        dependencies: new Set(),
      });
    if (kind === "runtime") {
      const w = workspaces.get(workspace);
      w.runtimeFiles++;
      w.runtimeLines += entry.lines ?? 0;
    }
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const outgoing = new Set();
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        outgoing.add(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        outgoing.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(file);
    for (const to of outgoing) {
      imports.push({ from: path, to, kind });
      const dependency =
        /^@pi-cloud\/([^/]+)/.exec(to)?.[1] ??
        (to.startsWith(".")
          ? /^packages\/([^/]+)\//.exec(posix.normalize(posix.join(posix.dirname(path), to)))?.[1]
          : undefined);
      if (workspace && kind === "runtime" && dependency && dependency !== workspace)
        workspaces.get(workspace).dependencies.add(dependency);
    }
    if (kind === "runtime")
      entry.riskSignals = {
        sql: (source.match(/\.execute(?:TakeFirst(?:OrThrow)?)?\(/g) ?? []).length,
        timers: (source.match(/set(?:Timeout|Interval)\(/g) ?? []).length,
        catch: (source.match(/\bcatch\b/g) ?? []).length,
      };
  }
  files.push(entry);
}
const workspaceList = [...workspaces.values()]
  .map((w) => ({ ...w, dependencies: [...w.dependencies].sort() }))
  .sort((a, b) => a.name.localeCompare(b.name));
const cycles = new Set();
for (const w of workspaceList) {
  const visit = (name, path) => {
    const i = path.indexOf(name);
    if (i >= 0) {
      const c = path.slice(i);
      const rotations = c.map((_, n) => [...c.slice(n), ...c.slice(0, n)].join(" -> "));
      cycles.add(rotations.sort()[0]);
      return;
    }
    for (const next of workspaces.get(name)?.dependencies ?? []) visit(next, [...path, name]);
  };
  visit(w.name, []);
}
const report = {
  format: "pi-cloud.repository-review-coverage.v3",
  revision,
  scopeNote:
    "Inventory and import/risk scan are not line-by-line verification. Manual boundary coverage and empirical evidence are recorded separately in the review report.",
  trackedFiles: files.length,
  runtimeFiles: files.filter((f) => f.kind === "runtime").length,
  runtimeLines: files.filter((f) => f.kind === "runtime").reduce((s, f) => s + (f.lines ?? 0), 0),
  workspaceImportCycles: [...cycles],
  workspaces: workspaceList,
  files,
  imports,
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-review-20261004/inventory.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    revision,
    trackedFiles: report.trackedFiles,
    runtimeFiles: report.runtimeFiles,
    runtimeLines: report.runtimeLines,
    workspaces: workspaceList.map((w) => ({
      name: w.name,
      files: w.runtimeFiles,
      lines: w.runtimeLines,
    })),
    cycles: [...cycles],
  }),
);
