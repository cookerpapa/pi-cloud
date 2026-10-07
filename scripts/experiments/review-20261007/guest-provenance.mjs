// Read-only comparison of reusable guest inputs and the actual release inspector.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { guestBuildIdentity } from "../../lib/guest-build-identity.mjs";
import { inspectReleaseImage } from "../../lib/release-image-evidence.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const capture = async (command, args) =>
  (await execute(command, args, { cwd: root, maxBuffer: 1024 * 1024 })).stdout.trim();
const identity = await guestBuildIdentity(root);
const revision = await capture("git", ["rev-parse", "HEAD"]);
const reference = process.argv[2] ?? `localhost:5000/pi-cloud/cubesandbox-tool:${identity}`;
const image = await inspectReleaseImage(
  {
    reference,
    labelVersion: "cube-primary",
    releaseRevision: revision,
    repositoryRoot: root,
    guestIdentity: identity,
  },
  capture,
);
assert.equal(image.provenance.guestBuildIdentity, identity);
const result = { revision, identity, reference, image };
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
