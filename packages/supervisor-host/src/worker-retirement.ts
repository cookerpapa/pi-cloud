export class WorkerRetirementTimeout extends Error {
  readonly code = "worker_retirement_timeout";
  constructor() {
    super("Worker retirement did not confirm local execution settlement");
  }
}

async function settledWithin(pending: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runtime retirement is bounded independently of Agent work. A timeout never
 * constitutes owner-exit proof or releases the existing PG/Kafka grant. */
export async function settleWorkerExecutions(options: {
  stopClaimsAndJoin(): Promise<void>;
  waitAssignments(): Promise<void>;
  retire(): void;
  drainMs: number;
  retirementMs: number;
  allowDrain: boolean;
}): Promise<void> {
  const settled = options.stopClaimsAndJoin().then(() => options.waitAssignments());
  try {
    if (options.allowDrain && (await settledWithin(settled, options.drainMs))) return;
    options.retire();
    if (!(await settledWithin(settled, options.retirementMs))) throw new WorkerRetirementTimeout();
  } catch (error) {
    options.retire();
    throw error;
  }
}
