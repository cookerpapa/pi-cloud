import { readdir } from "node:fs/promises";
const names = new Set(await readdir(process.cwd()));
const manifests = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"];
console.log(
  JSON.stringify({
    directory: process.cwd(),
    manifests: manifests.filter((name) => names.has(name)),
    hasReadme: names.has("README.md"),
  }),
);
