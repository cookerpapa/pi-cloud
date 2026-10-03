#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { renderCubeRelease } from "./lib/cube-release-render.mjs";
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  process.stdout.write(renderCubeRelease(Buffer.concat(chunks).toString(), input));
} catch {
  // Rendered manifests include credentials. Do not echo YAML or parser context.
  process.stderr.write("Cube release rendering failed; inspect pinned chart/input contracts\n");
  process.exitCode = 1;
}
