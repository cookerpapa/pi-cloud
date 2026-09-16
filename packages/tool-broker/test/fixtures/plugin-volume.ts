import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Consumer fixture only; the actual shell plugin has a separate lifecycle test. */
export async function createPluginVolumeFixture(root: string, input: { volumeId: string }) {
  const volume = join(root, `picloud-posix-${input.volumeId}`);
  await mkdir(join(volume, "workspace"), { recursive: true });
  await mkdir(join(volume, ".pi-cloud-runtime"), { recursive: true });
  await writeFile(
    join(volume, ".pi-cloud-runtime/identity"),
    `pi-cloud-volume-v1\n${input.volumeId}\n${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o400 },
  );
}
