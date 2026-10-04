// Control experiment only: keep the maintained browser gate unchanged, update
// its old queue stub to the current schema in a temporary sibling script.
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const before =
  "getInputQueue:async(sessionId)=>({...structuredClone(window.fixtureQueue),sessionId}),";
const after =
  "getInputQueue:async(sessionId)=>({...structuredClone(window.fixtureQueue),sessionId,viewVersion:String(window.fixtureQueue.revision),afterPosition:0,hasMore:false,hasPausedInputs:false,items:window.fixtureQueue.items.map(i=>({...i,paused:false}))}),";
const source = await readFile(
  new URL("./run-browser-presentation-check.mjs", import.meta.url),
  "utf8",
);
if (!source.includes(before)) throw Error("Review browser fixture no longer matches the baseline");
const path = new URL(`./.review-browser-${randomUUID()}.mjs`, import.meta.url);
try {
  await writeFile(path, source.replace(before, after), { flag: "wx" });
  const p = spawn(process.execPath, [fileURLToPath(path)], { stdio: "inherit" });
  await new Promise((ok, fail) => {
    p.on("error", fail);
    p.on("exit", (n) => (n === 0 ? ok() : fail(Error(`Browser control experiment exited ${n}`))));
  });
} finally {
  await rm(path, { force: true });
}
