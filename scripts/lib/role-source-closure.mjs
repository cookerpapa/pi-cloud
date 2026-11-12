import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { build, version as esbuildVersion } from "esbuild";

const require = createRequire(import.meta.url);
const entries = {
  worker: "packages/supervisor-host/src/main.ts",
  sessionApi: "packages/control-plane/src/session-api-main.ts",
  sessionRuntime: "packages/control-plane/src/session-runtime-main.ts",
  management: "packages/control-plane/src/main.ts",
  toolHost: "packages/control-plane/src/tool-host-main.ts",
  metering: "packages/accounting/src/main.ts",
  completion: "packages/cube-completion/src/main.ts",
  volumeGateway: "packages/sandbox-control/src/workspace-volume-gateway-main.ts",
  android: "packages/android-executor/src/main.ts",
  boxlite: "packages/boxlite-node/src/main.ts",
};

/** This inspects runtime imports, including statically resolvable dynamic imports.
 * It does not replace Docker COPY/asset identities or actual image boot checks,
 * and does not grant a component release merely because a bundle tree-shakes. */
export async function checkRoleSourceClosure(root, outputPath) {
  const roles = {};
  for (const [role, entry] of Object.entries(entries)) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "inspect-workspace-source",
          setup(builder) {
            builder.onResolve({ filter: /^@pi-cloud\// }, (args) => ({
              path: require.resolve(args.path, { paths: [dirname(args.importer)] }),
            }));
          },
        },
      ],
    });
    const imported = Object.keys(result.metafile.inputs).sort();
    const bytes = new Map();
    for (const output of Object.values(result.metafile.outputs))
      for (const [path, value] of Object.entries(output.inputs))
        if (value.bytesInOutput > 0) bytes.set(path, (bytes.get(path) ?? 0) + value.bytesInOutput);
    const externalImports = [
      ...new Set(
        Object.values(result.metafile.inputs)
          .flatMap((input) => input.imports)
          .filter((input) => input.external)
          .map((input) => input.path),
      ),
    ].sort();
    if (role === "worker")
      for (const path of imported)
        assert(
          !/^packages\/(control-plane|accounting)\//.test(path),
          `Worker runtime import crosses its role: ${path}`,
        );
    if (role === "sessionApi" || role === "toolHost")
      for (const path of imported)
        assert(
          !/^packages\/sandbox-control\/src\/(?:index|fixed-guest-sandbox-provider|cubesandbox-sandbox-provider|resource-backend-fleet)\.ts$/.test(
            path,
          ),
          `${role} imports provider assembly instead of a narrow client: ${path}`,
        );
    roles[role] = {
      entry,
      imported,
      contributing: [...bytes.keys()].sort(),
      externalImports,
    };
    console.log(
      `role_source_closure_passed role=${role} imported=${imported.length} contributing=${bytes.size} external=${externalImports.length}`,
    );
  }
  if (outputPath)
    await writeFile(
      outputPath,
      JSON.stringify(
        {
          format: 1,
          revision: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: root,
            encoding: "utf8",
          }).trim(),
          esbuildVersion,
          roles,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
}
