import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, "node_modules/@discoveryjs/json-ext");
const check = process.argv.slice(2).includes("--check");
// Preserve JSON.parse's own __proto__ keys during chunked object merges.
// This pinned correction is independent of the removed Pi CLI dependency.
if (existsSync(directory)) {
  if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version !== "1.1.0")
    throw new Error("Review json-ext preparation for this version");
  const original = "Object.assign(currentRootValueCursor.value, JSON.parse(fragment));";
  const corrected =
    "Object.defineProperties(currentRootValueCursor.value, Object.getOwnPropertyDescriptors(JSON.parse(fragment)));";
  for (const file of ["src/parse-chunked.js", "cjs/parse-chunked.cjs"]) {
    const path = join(directory, file),
      source = readFileSync(path, "utf8");
    if (source.includes(corrected)) continue;
    if (check || !source.includes(original))
      throw new Error(`json-ext object merge is not prepared: ${file}`);
    writeFileSync(path, source.replace(original, corrected));
  }
}
console.log("json_parser_preparation_passed");
