import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
async function measure() {
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["packages/tool-sandbox/src/envd-tool-exec.ts"],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["sharp"],
    outdir: "unused-review-output",
    logLevel: "silent",
  });
  const output = Object.values(bundle.metafile.outputs)[0];
  const modules = new Map();
  for (const [path, value] of Object.entries(output.inputs)) {
    if (!path.includes("node_modules/")) continue;
    const tail = path.split("node_modules/").at(-1);
    const name = tail.startsWith("@") ? tail.split("/").slice(0, 2).join("/") : tail.split("/")[0];
    modules.set(name, (modules.get(name) ?? 0) + value.bytesInOutput);
  }
  return {
    bytes: output.bytes,
    modules: Object.fromEntries(
      [...modules].filter(([name]) =>
        [
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-mcp",
          "@earendil-works/pi-codemode",
          "@earendil-works/pi-tui",
          "@earendil-works/pi-ai",
          "openai",
          "@anthropic-ai/sdk",
          "@google/genai",
        ].includes(name),
      ),
    ),
  };
}
console.log(
  JSON.stringify({
    id: "guest-bundle",
    current: await measure(),
  }),
);
