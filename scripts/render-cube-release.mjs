#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";
import { renderCubeRelease } from "./lib/cube-release-render.mjs";
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  const rendered = renderCubeRelease(Buffer.concat(chunks).toString(), input);
  if (input.validation) {
    const { binary, prefix, kubeconfig } = input.validation;
    const items = parseAllDocuments(rendered, { version: "1.1" })
      .map((d) => d.toJS())
      .filter((r) => r && !r.metadata?.annotations?.["helm.sh/hook"]);
    execFileSync(
      binary,
      [
        ...prefix,
        "--kubeconfig",
        kubeconfig,
        "-n",
        "cube-system",
        "apply",
        "--dry-run=server",
        "-f",
        "-",
        "-o",
        "name",
      ],
      {
        input: JSON.stringify({ apiVersion: "v1", kind: "List", items }),
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120000,
      },
    );
  }
  process.stdout.write(rendered);
} catch {
  // Rendered manifests include credentials. Do not echo YAML or parser context.
  process.stderr.write("Cube release rendering failed; inspect pinned chart/input contracts\n");
  process.exitCode = 1;
}
