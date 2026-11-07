import { resolve } from "node:path";
import { readPrivateRuntimeFile } from "./lib/runtime-file-policy.mjs";
import { createWorkspaceStoragePoolGuard } from "./lib/workspace-storage-pool-guard.mjs";
import {
  inspectWorkspaceStoragePool,
  prepareWorkspaceStoragePool,
  verifyWorkspaceStoragePool,
  growWorkspaceStoragePool,
} from "./lib/workspace-storage-pool.mjs";

const [operation, ...args] = process.argv.slice(2);
const flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (
    !["--plan", "--runtime-directory", "--pool-bytes"].includes(args[i]) ||
    !args[i + 1] ||
    flags.has(args[i])
  )
    throw new Error(
      "Usage: run-workspace-storage-pool.mjs plan|prepare --plan PRIVATE_JSON; verify|grow --runtime-directory ABSOLUTE_PATH [--pool-bytes BYTES]",
    );
  flags.set(args[i], args[i + 1]);
}
let guard;
try {
  let result;
  if (operation === "plan" || operation === "prepare") {
    if (!flags.has("--plan") || flags.size !== 1)
      throw new Error("A private bounded operator plan file is required");
    const options = JSON.parse(
      await readPrivateRuntimeFile(
        resolve(flags.get("--plan")),
        16 * 1024 ** 2,
        "Workspace migration plan",
      ),
    );
    if (operation === "plan") result = await inspectWorkspaceStoragePool(options);
    else if ((await inspectWorkspaceStoragePool(options)).state === "complete") {
      // A completed operation has no mutation to authorize. Verify the owned
      // mount without requiring the PG that K3s cannot start until it is ready.
      result = await verifyWorkspaceStoragePool(options);
    } else {
      guard = await createWorkspaceStoragePoolGuard(options, {
        planPath: resolve(flags.get("--plan")),
      });
      // First-installation still checks actual installed writer/native Pods, but
      // does not require PostgreSQL, a Workspace inventory or a quota helper.
      if (options.fresh) await guard.assertQuiescent();
      result = await prepareWorkspaceStoragePool({
        ...options,
        assertQuiescent: guard.assertQuiescent,
      });
    }
  } else if (operation === "verify" || operation === "grow") {
    if (!flags.has("--runtime-directory") || flags.has("--plan"))
      throw new Error("An absolute runtime directory is required");
    const options = {
      runtimeDirectory: flags.get("--runtime-directory"),
      ...(flags.has("--pool-bytes") ? { poolBytes: Number(flags.get("--pool-bytes")) } : {}),
    };
    result = await (operation === "verify"
      ? verifyWorkspaceStoragePool(options)
      : growWorkspaceStoragePool(options));
  } else throw new Error("Unknown Workspace storage pool operation");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: error.message, ...(error.plan ? { plan: error.plan } : {}) }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await guard?.close();
}
