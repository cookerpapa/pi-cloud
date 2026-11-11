import { readFile, readdir } from "node:fs/promises";

export type NativeProcessEvidence = Readonly<{
  hostBootId: string;
  processes: readonly { pid: number; startTime: string }[];
}>;

async function processStart(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid native process identity");
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const start = fields[19];
    if (!start || !/^\d+$/.test(start)) throw new Error("Native process evidence is incomplete");
    return start;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const hostBoot = async () => (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();

/** Run in the host PID namespace. Missing native inventory is insufficient;
 * capture the owned VMM/helper processes while the SDK still knows the Box. */
export async function captureNativeProcesses(pid: number): Promise<NativeProcessEvidence> {
  const processes: { pid: number; startTime: string }[] = [];
  const remaining = [pid],
    seen = new Set<number>();
  while (remaining.length) {
    const current = remaining.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (seen.size > 256) throw new Error("Native process tree exceeded its evidence bound");
    const startTime = await processStart(current);
    if (!startTime) throw new Error("Native process disappeared during creation evidence");
    processes.push({ pid: current, startTime });
    const threads = await readdir(`/proc/${current}/task`);
    if (threads.length > 256) throw new Error("Native thread evidence exceeded its bound");
    for (const thread of threads) {
      try {
        const children = (
          await readFile(`/proc/${current}/task/${thread}/children`, "utf8")
        ).trim();
        if (children) remaining.push(...children.split(/\s+/).map(Number));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return { hostBootId: await hostBoot(), processes };
}

export async function confirmsNativeAbsence(evidence: NativeProcessEvidence): Promise<boolean> {
  if (
    !/^[0-9a-f-]{36}$/.test(evidence.hostBootId) ||
    !evidence.processes.length ||
    evidence.processes.length > 256
  )
    throw new Error("Original physical evidence is unavailable");
  if ((await hostBoot()) !== evidence.hostBootId) return true;
  for (const process of evidence.processes) {
    if ((await processStart(process.pid)) === process.startTime) return false;
  }
  return true;
}
