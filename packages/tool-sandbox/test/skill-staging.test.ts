import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { prepareSkillPackage } from "../src/skill-package-files.ts";

async function heldPreparation(phase: "before" | "after") {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-crash-"));
  const bytes = Buffer.from(
    JSON.stringify({
      name: "crash-skill",
      requirements: { runtime: "none", tools: [], software: [] },
      files: [
        { path: "SKILL.md", base64: Buffer.from("Managed instructions").toString("base64") },
        { path: "scripts/run.sh", base64: Buffer.from("echo bounded").toString("base64") },
      ],
    }),
  );
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(root, "input.json"), bytes);
  const source = new URL("../src/skill-package-files.ts", import.meta.url).href;
  const script = `
    import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.promises.rename;const hold=async()=>{setInterval(()=>{},1000);process.stdout.write('STAGED');await new Promise(()=>{});};
    fs.promises.rename=async(from,to)=>{
      if(String(from).includes('/prepare-')&&String(to).endsWith('/SKILL.md')){
        if(${JSON.stringify(phase)}==='before')await hold();
        await rename(from,to);await hold();
      }else return rename(from,to);
    };syncBuiltinESMExports();
    const {prepareSkillPackage}=await import(${JSON.stringify(source)});
    await prepareSkillPackage(process.argv[1],await fs.promises.readFile(process.argv[1]+'/input.json'),process.argv[2]);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script, root, digest],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let error = "";
  child.stderr!.on("data", (chunk) => {
    error += String(chunk);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    await Promise.race([
      once(child.stdout!, "data").then(([chunk]) => {
        expect(String(chunk)).toBe("STAGED");
      }),
      once(child, "exit").then(() => {
        throw new Error("Fixture child exited before staging: " + error);
      }),
    ]);
  } catch (error) {
    await stop(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const area = join(root, ".pi-cloud", "skill-staging", "files");
  const receipt = JSON.parse(await readFile(join(area, "pending.json"), "utf8"));
  return { root, bytes, digest, child, area, stage: join(area, receipt.directory) };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

it.each(["before", "after"] as const)(
  "reclaims killed %s-rename staging, while live ownership blocks a competing prepare",
  async (phase) => {
    const f = await heldPreparation(phase);
    try {
      let settled = false;
      const waiting = prepareSkillPackage(f.root, f.bytes, f.digest).finally(() => {
        settled = true;
      });
      void waiting.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(await readdir(f.stage)).not.toHaveLength(0);
      await stop(f.child);
      const result = await waiting;
      expect(await readFile(join(result.path, "SKILL.md"), "utf8")).toBe("Managed instructions");
      expect(await readdir(f.area)).toEqual([]);
      expect(await readdir(join(f.root, ".pi-cloud", "skills"))).toEqual([
        `crash-skill-${f.digest}`,
      ]);
    } finally {
      await stop(f.child);
      await rm(f.root, { recursive: true, force: true });
    }
  },
  30000,
);

it("preserves modified abandoned staging for inspection instead of deleting user bytes", async () => {
  const f = await heldPreparation("after");
  try {
    await stop(f.child);
    await writeFile(join(f.stage, "SKILL.md"), "User edits in an interrupted copy");
    await expect(prepareSkillPackage(f.root, f.bytes, f.digest)).rejects.toThrow("modified");
    expect(await readFile(join(f.stage, "SKILL.md"), "utf8")).toBe(
      "User edits in an interrupted copy",
    );
    expect(await readdir(f.area)).toContain("pending.json");
  } finally {
    await stop(f.child);
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);
