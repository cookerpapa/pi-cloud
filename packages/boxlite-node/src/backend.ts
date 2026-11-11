import { JsBoxlite, type Boxlite, type JsBoxInfo } from "@boxlite-ai/boxlite";
import { isDeepStrictEqual } from "node:util";
import { SocketAddress } from "node:net";
import type { Duplex } from "node:stream";
import { GUEST_EXECUTOR_MAX_INPUT, GUEST_EXECUTOR_MAX_OUTPUT } from "@pi-cloud/protocol";
import type {
  GuestRuntimeCreateInput,
  GuestCommandRequest,
  GuestRuntimeClient,
} from "@pi-cloud/sandbox-control/guest-runtime";
import type {
  BoxLiteImageProfile,
  BoxLiteInstance,
} from "@pi-cloud/sandbox-control/boxlite-node-contract";
import { AllocationAdmission } from "./allocation-admission.ts";
import { AllocationReceipts, allocationName, allocationFromName } from "./allocation-receipt.ts";
import { VolumeAttachments } from "./volume-attachments.ts";
import { captureNativeProcesses, confirmsNativeAbsence } from "./native-process-evidence.ts";
import {
  collectExecution,
  executionStream,
  tunnelStream,
  type NativeBox,
  type NativeExecution,
} from "./native-streams.ts";

/** Mechanical SDK adapter. It has no PG/Kafka/model client or resource timer.
 * The fixed Guest owns Tool admission, cancellation and HTTPS completion. */
export class BoxLiteNodeBackend {
  readonly #runtime: Boxlite;
  readonly #admission = new AllocationAdmission();
  readonly #handles = new Map<string, NativeBox>();
  readonly #receipts: AllocationReceipts;
  readonly #volumes: VolumeAttachments;
  readonly #creating = new Set<string>();
  constructor(
    readonly options: {
      nodeId: string;
      directory: string;
      volumePlugin: string;
      profiles: Readonly<Record<string, BoxLiteImageProfile>>;
      registries: ConstructorParameters<typeof JsBoxlite>[0]["imageRegistries"];
      allowedAddresses: readonly string[];
    },
  ) {
    this.#runtime = new JsBoxlite({
      homeDir: options.directory + "/native",
      ...(options.registries ? { imageRegistries: options.registries } : {}),
    });
    this.#receipts = new AllocationReceipts(options.directory + "/connections");
    this.#volumes = new VolumeAttachments(options.volumePlugin, "boxlite-" + options.nodeId);
  }
  async ready() {
    await this.#runtime.listInfo();
  }
  async prepareImages() {
    const cached = new Set((await this.#runtime.images.list()).map((image) => image.reference));
    for (const image of new Set(
      Object.values(this.options.profiles).map((profile) => profile.image),
    ))
      if (!cached.has(image)) await this.#runtime.images.pull(image);
  }
  async inventory() {
    return {
      native: (await this.#runtime.listInfo()).length,
      receipts: await this.#receipts.count(),
      creating: this.#creating.size,
    };
  }

  async #receipt(info: JsBoxInfo) {
    const activationId = allocationFromName(info.name);
    const receipt = activationId ? await this.#receipts.read(activationId) : undefined;
    if (!receipt) throw new Error("Recorded allocation connection is unavailable");
    const profile = this.options.profiles[receipt.request.templateId];
    if (
      !profile ||
      info.cpus !== profile.cpus ||
      info.memoryMib !== profile.memoryMiB ||
      info.image !== profile.image ||
      receipt.request.metadata["picloud.workspace_runtime_id"] !== activationId
    )
      throw new Error("Native allocation differs from its recorded specification");
    return receipt;
  }
  async #instance(info: JsBoxInfo): Promise<BoxLiteInstance> {
    const receipt = await this.#receipt(info);
    return {
      sandboxId: info.id,
      templateId: receipt.request.templateId,
      nodeId: this.options.nodeId,
      state: info.state.running
        ? "running"
        : info.state.status.toLowerCase() === "stopped"
          ? "paused"
          : "unknown",
      metadata: receipt.request.metadata,
      cpuCount: info.cpus,
      memoryMB: info.memoryMib,
      attachment: receipt.attachment,
      ...(info.state.running && info.state.pid
        ? { connection: await captureNativeProcesses(info.state.pid) }
        : {}),
    };
  }
  async read(id: string): Promise<BoxLiteInstance | undefined> {
    const info = await this.#runtime.getInfo(id);
    return info ? this.#instance(info) : undefined;
  }
  async list(): Promise<BoxLiteInstance[]> {
    const result: BoxLiteInstance[] = [];
    for (const info of await this.#runtime.listInfo()) {
      if (allocationFromName(info.name)) {
        // An unresolved connection must not hide other owned resources. The
        // caller never treats an omitted inventory item as deletion evidence.
        try {
          result.push(await this.#instance(info));
        } catch {
          /* unresolved */
        }
      }
    }
    return result;
  }
  async observe(id: string, expected?: BoxLiteInstance): ReturnType<GuestRuntimeClient["observe"]> {
    const info = await this.#runtime.getInfo(id);
    if (info)
      return {
        runtimeName: id,
        nodeId: this.options.nodeId,
        presence: "present",
        state: info.state.running
          ? "running"
          : info.state.status.toLowerCase() === "stopped"
            ? "paused"
            : "unknown",
      };
    const confirmed =
      expected?.sandboxId === id &&
      expected.nodeId === this.options.nodeId &&
      expected.connection &&
      (await confirmsNativeAbsence(expected.connection));
    return {
      runtimeName: id,
      nodeId: this.options.nodeId,
      presence: confirmed ? "absent" : "unavailable",
      state: "unknown",
    };
  }
  async #box(id: string, running = true): Promise<NativeBox> {
    const info = await this.#runtime.getInfo(id);
    if (!info || info.id !== id) throw new Error("allocation_unavailable");
    await this.#receipt(info);
    // BoxLite exec can boot a stopped Box. Ordinary control/Tool requests must
    // never use that behavior; only explicit management resume calls start().
    if (running && !info.state.running) throw new Error("allocation_not_running");
    let box = this.#handles.get(id);
    if (!box) {
      box = (await this.#runtime.get(id)) ?? undefined;
      if (!box) throw new Error("allocation_unavailable");
      this.#handles.set(id, box);
    }
    return box;
  }
  async create(request: GuestRuntimeCreateInput): Promise<BoxLiteInstance> {
    const activationId = request.metadata["picloud.workspace_runtime_id"];
    const profile = this.options.profiles[request.templateId],
      mount = request.volumeMounts?.[0];
    if (
      !activationId ||
      !profile ||
      request.volumeMounts?.length !== 1 ||
      !mount ||
      !["/workspace", "/home/user"].includes(mount.path) ||
      !profile.image.includes("@sha256:")
    )
      throw new Error("Invalid BoxLite creation specification");
    if (this.#creating.has(activationId)) throw new Error("creation_already_issued");
    this.#creating.add(activationId);
    try {
      if (await this.#receipts.read(activationId)) throw new Error("creation_already_issued");
      const attachment = await this.#volumes.attach(mount.name, activationId);
      await this.#receipts.save({ version: 1, activationId, request, attachment });
      // Never getOrCreate or retry this call after an uncertain receipt.
      const box = await this.#runtime.create(
        {
          image: profile.image,
          cpus: profile.cpus,
          memoryMib: profile.memoryMiB,
          diskSizeGb: profile.diskGiB,
          user: "0:0",
          entrypoint: ["/bin/sleep"],
          cmd: ["infinity"],
          advanced: { privileged: true },
          security: { jailerEnabled: false, seccompEnabled: false },
          detach: true,
          autoStop: 0,
          autoDelete: 0,
          autoResume: false,
          volumes: [{ hostPath: attachment.hostPath, guestPath: mount.path, readOnly: false }],
          network: {
            outbound: { mode: "enabled", allowNet: [...this.options.allowedAddresses] },
            inbound: { mode: "enabled" },
          },
        },
        allocationName(activationId),
      );
      this.#handles.set(box.id, box);
      await box.start();
      return this.#instance(await box.info());
    } finally {
      this.#creating.delete(activationId);
    }
  }
  async pause(id: string): Promise<void> {
    await this.#admission.retryClose(id, async () => {
      const box = await this.#box(id, false);
      await box.stop();
      this.#handles.delete(id);
    });
  }
  async resume(id: string): Promise<BoxLiteInstance> {
    let result: BoxLiteInstance | undefined;
    await this.#admission.use(id, async () => {
      const box = await this.#box(id, false);
      await box.start();
      result = await this.#instance(await box.info());
    });
    return result!;
  }
  async destroy(expected: BoxLiteInstance): Promise<void> {
    if (expected.nodeId !== this.options.nodeId) throw new Error("Allocation node changed");
    await this.#admission.retryClose(expected.sandboxId, async () => {
      const info = await this.#runtime.getInfo(expected.sandboxId);
      const activationId = expected.metadata["picloud.workspace_runtime_id"];
      const receipt = activationId ? await this.#receipts.read(activationId) : undefined;
      if (
        (receipt &&
          (!isDeepStrictEqual(receipt.request.metadata, expected.metadata) ||
            !isDeepStrictEqual(receipt.attachment, expected.attachment))) ||
        (!receipt && info) ||
        !activationId ||
        expected.attachment.sandboxId !== activationId
      )
        throw new Error("Allocation deletion receipt is unavailable");
      const current = info ? await this.#instance(info) : undefined;
      const evidence = current?.connection ?? expected.connection;
      if (!evidence) throw new Error("Original physical process evidence is unavailable");
      if (info) {
        const box = await this.#box(info.id, false);
        await box.stop();
        this.#handles.delete(info.id);
        await this.#runtime.remove(info.id, false);
      }
      if (
        (await this.#runtime.getInfo(expected.sandboxId)) ||
        !(await confirmsNativeAbsence(evidence))
      )
        throw new Error("Physical allocation deletion is unconfirmed");
      // A lost delete ACK may arrive after local metadata cleanup. The PG-held
      // capsule retains the exact attachment and physical evidence; repeating
      // its confirmed detach is harmless and needs no tombstone ledger.
      await this.#volumes.detach(expected.attachment);
      if (receipt) await this.#receipts.forget(receipt.activationId);
    });
  }
  async command(id: string, input: Omit<GuestCommandRequest, "signal" | "onStdout">) {
    return this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const execution = await box.exec(
        "/bin/bash",
        ["-lc", input.command],
        null,
        false,
        input.user,
        Math.max(1, Math.ceil(input.timeoutMs / 1000)),
        input.cwd,
      );
      return collectExecution(
        execution,
        input.maximumOutputBytes,
        AbortSignal.timeout(input.timeoutMs),
      );
    });
  }
  async writeFile(
    id: string,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !/^\/tmp\/pi-cloud-[A-Za-z0-9_.-]+$/.test(path) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0
    )
      throw new Error("Invalid fixed Guest staging transfer");
    await this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const script = `const fs=require('node:fs');const [p,n]=process.argv.slice(1);let size=0,owned=false,failed=false;
const f=fs.createWriteStream(p,{flags:'wx',mode:384});
const fail=()=>{if(failed)return;failed=true;process.stdin.destroy();f.destroy();if(owned)try{fs.unlinkSync(p)}catch{};process.exitCode=1};
f.on('open',()=>{owned=true;if(failed)try{fs.unlinkSync(p)}catch{}});
f.on('error',fail);process.stdin.on('error',fail);
process.stdin.on('data',c=>{size+=c.length;if(size>Number(n))fail()});
process.stdin.pipe(f);f.on('finish',()=>{if(size!==Number(n))fail();else process.stdout.write('STORED')});`;
      const execution = await box.exec(
        "node",
        ["-e", script, path, String(byteLength)],
        null,
        false,
        "0:0",
      );
      const input = await execution.stdin();
      const result = collectExecution(execution, 8192, signal);
      void result.catch(() => {});
      let received = 0;
      try {
        for await (const chunk of chunks) {
          signal?.throwIfAborted();
          received += chunk.byteLength;
          if (received > byteLength) throw new Error("Guest transfer exceeded its declared size");
          await input.write(Buffer.from(chunk));
        }
        await input.close();
        const output = await result;
        if (received !== byteLength || output.exitCode !== 0 || output.stdout !== "STORED")
          throw new Error("Guest transfer was not confirmed");
      } catch (error) {
        await input.close().catch(() => {});
        await execution.kill().catch(() => {});
        throw error;
      }
    });
  }
  async guest(id: string, request: object): Promise<Record<string, unknown>> {
    const body = Buffer.from(JSON.stringify(request) + "\n");
    if (body.length > GUEST_EXECUTOR_MAX_INPUT) throw new Error("Guest request exceeded its bound");
    return this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const execution = await box.exec(
        "node",
        ["/opt/pi-cloud/bin/guest-executor-client.mjs"],
        null,
        false,
        "0:0",
        15,
      );
      const input = await execution.stdin();
      const result = collectExecution(
        execution,
        GUEST_EXECUTOR_MAX_OUTPUT + 1024,
        AbortSignal.timeout(15000),
      );
      void result.catch(() => {});
      await input.write(body);
      await input.close();
      const output = await result;
      const lines = output.stdout.trim().split("\n");
      if (output.exitCode !== 0 || lines[0] !== "PI_CLOUD_GUEST_READY")
        throw new Error("Guest admission reply is unconfirmed");
      return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    });
  }
  async tcp(id: string, port: number): Promise<Duplex> {
    return this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const tunnel = await box.network.tunnel(new SocketAddress({ address: "127.0.0.1", port }), {
        isPublic: false,
      });
      return tunnelStream(await tunnel.connect());
    });
  }
  async program(
    id: string,
    script: string,
    cwd: string,
    tty: boolean,
    admin = false,
  ): Promise<{ execution: NativeExecution; stream: Duplex }> {
    return this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const command = admin ? "/bin/bash" : "/usr/bin/setpriv";
      const args = admin
        ? ["-lc", script]
        : [
            "--reuid=1000",
            "--regid=1000",
            "--clear-groups",
            "--no-new-privs",
            "--bounding-set=-all",
            "--inh-caps=-all",
            "--ambient-caps=-all",
            "/bin/bash",
            "-lc",
            script,
          ];
      const execution = await box.exec(command, args, null, tty, "0:0", null, cwd);
      return { execution, stream: await executionStream(execution, tty, !tty) };
    });
  }
  async executionControl(
    id: string,
    executionId: string,
    action: "kill" | "resize",
    size?: { rows: number; cols: number },
  ): Promise<void> {
    await this.#admission.use(id, async () => {
      const box = await this.#box(id);
      const execution = await box.executions().get(executionId);
      if (action === "kill") await execution.kill();
      else {
        if (
          !size ||
          !Number.isSafeInteger(size.rows) ||
          !Number.isSafeInteger(size.cols) ||
          size.rows < 1 ||
          size.cols < 1 ||
          size.rows > 1000 ||
          size.cols > 1000
        )
          throw new Error("Invalid terminal dimensions");
        await execution.resizeTty(size.rows, size.cols);
      }
    });
  }
  async close() {
    // Detached VMs belong to PG resource intent, not this disposable API process.
    this.#runtime.close();
  }
}
