import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
const files = [
  resolve(repositoryRoot, "README.md"),
  ...readdirSync(resolve(repositoryRoot, "docs"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => resolve(repositoryRoot, "docs", entry.name)),
  ...readdirSync(resolve(repositoryRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(repositoryRoot, "packages", entry.name, "README.md"))
    .filter(existsSync),
];

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1]?.trim();
    if (
      target === undefined ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    const path = decodeURIComponent(target.split("#", 1)[0] ?? "");
    assert.ok(path.length > 0 && existsSync(resolve(dirname(file), path)), `${file}: ${target}`);
  }
  for (const match of text.matchAll(/npm run ([a-z0-9:._-]+)/gu)) {
    const script = match[1];
    assert.equal(
      typeof rootPackage.scripts?.[script] === "string",
      true,
      `${file}: npm script ${script} does not exist`,
    );
  }
}

process.stdout.write(`documentation_check_passed files=${String(files.length)}\n`);
