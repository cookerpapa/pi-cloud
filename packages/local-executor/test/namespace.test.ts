import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { it, expect } from "vitest";
import { localNamespaceArguments } from "../src/launch.ts";

it.skipIf(process.env.PI_CLOUD_LOCAL_EXECUTION_CHECK !== "1")(
  "executes fixed local Tools in a persistent namespace with bounded output and cancellation",
  async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "pma-local-check-"));
    await mkdir(dir + "/project");
    const { default: sharp } = await import("sharp");
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toFile(dir + "/project/image.png");
    await writeFile(dir + "/token", "t".repeat(32), { mode: 0o600 });
    try {
      const args = await localNamespaceArguments({
        repository: resolve(import.meta.dirname, "../../.."),
        project: dir + "/project",
        receiverTokenFile: dir + "/token",
        targetId: randomUUID(),
        port: 19181,
      });
      const end = args.lastIndexOf("--");
      const code = `
      import { executeLocalTool } from '/app/packages/local-executor/src/driver.ts';
      import { existsSync } from 'node:fs';
      const signal = new AbortController().signal;
      await executeLocalTool('local_write', {path:'/workspace/note',content:'before'}, signal);
      await executeLocalTool('local_edit', {path:'/workspace/note',edits:[{oldText:'before',newText:'after'}]}, signal);
      const read = await executeLocalTool('local_read', {path:'/workspace/note'}, signal);
      const image = await executeLocalTool('local_read', {path:'/workspace/image.png'}, signal);
      const blank = await executeLocalTool('local_bash', {command:'true'}, signal);
      const large = await executeLocalTool('local_bash', {command:"head -c 200000 /dev/zero | tr '\\\\0' x"}, signal);
      await executeLocalTool('local_bash', {command:'nohup sh -c "sleep 0.2; printf background > /workspace/background" >/dev/null 2>&1 &'}, signal);
      await new Promise(r=>setTimeout(r,500));
      const cancel = new AbortController(); setTimeout(()=>cancel.abort(),100);
      let cancelled=false; try { await executeLocalTool('local_bash',{command:'sleep 20'},cancel.signal); } catch {cancelled=true;}
      process.stdout.write(JSON.stringify({read,blank,imageType:image.content.find(p=>p.type==="image")?.mimeType,largeBytes:JSON.stringify(large).length,largeTextBytes:large.content[0].text.length,background:existsSync('/workspace/background'),outsideVisible:existsSync(${JSON.stringify(dir + "/token")}),cancelled}));
    `;
      const child = spawn(
        "bwrap",
        [
          ...args.slice(0, end),
          "--",
          "/usr/local/bin/node",
          "--import",
          "/app/node_modules/tsx/dist/loader.mjs",
          "--input-type=module",
          "-e",
          code,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const status = await new Promise<number | null>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", resolveExit);
      });
      expect(status, stderr).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.read.content[0].text).toContain("after");
      expect(result.imageType).toBe("image/png");
      expect(result.blank.content[0].text).toContain("no output");
      expect(result.largeTextBytes).toBeLessThan(53_000);
      expect(result.largeBytes).toBeLessThan(110_000);
      expect(result).toMatchObject({ background: true, outsideVisible: false, cancelled: true });
      expect(await readFile(dir + "/project/note", "utf8")).toBe("after");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
