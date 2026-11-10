import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { KafkaToolReplyMailbox } from "@pi-cloud/event-log";
import {
  OfficialCubeSandboxRuntimeClient,
  type CubeSandboxInstance,
  type CubeToolHandoff,
} from "../src/cubesandbox-runtime-client.ts";
import { ToolCompletionIssuer } from "../src/tool-completion-issuer.ts";

const enabled = process.env.PI_CLOUD_CUBESANDBOX_TEST === "1";
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
async function until<T>(read: () => Promise<T | undefined>, label: string, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v !== undefined) return v;
    await delay(150);
  }
  throw new Error(`Timed out: ${label}`);
}
it.skipIf(!enabled)(
  "Guest restart preserves accepted execution, exact cancellation and finite VM expiry",
  async () => {
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: required("PI_CLOUD_CUBESANDBOX_API_URL"),
      apiKey: (await readFile(required("PI_CLOUD_CUBESANDBOX_API_KEY_FILE"), "utf8")).trim(),
      proxyNodeIp: required("PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP"),
      proxyPort: Number(required("PI_CLOUD_CUBESANDBOX_PROXY_PORT")),
      proxyScheme: "http",
      sandboxDomain: required("PI_CLOUD_CUBESANDBOX_DOMAIN"),
      egressProxyIp: "10.255.255.254",
      completionIp: required("PI_CLOUD_TOOL_COMPLETION_IP"),
    });
    const issuer = new ToolCompletionIssuer({
      url: required("PI_CLOUD_TOOL_COMPLETION_URL"),
      ca: await readFile(required("PI_CLOUD_COMPLETION_CA_FILE"), "utf8"),
      secret: (
        await readFile(required("PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE"), "utf8")
      ).trim(),
    });
    const mailbox = new KafkaToolReplyMailbox({
      brokers: required("PI_CLOUD_KAFKA_BROKERS").split(","),
      bootId: randomUUID(),
      replicas: 3,
    });
    const allocations: CubeSandboxInstance[] = [];
    const sourceTopic = `guest-check-${randomUUID()}`;
    let offset = 0;
    const source = () => ({ topic: sourceTopic, partition: 0, offset: String(++offset) });
    const command = async (instance: CubeSandboxInstance, script: string) =>
      client.runCommand(instance, {
        command: script,
        cwd: "/",
        user: "root",
        timeoutMs: 15000,
        maximumOutputBytes: 4096,
      });
    const create = async (retentionMs?: number) => {
      const created = await client.create({
        templateId: required("PI_CLOUD_CUBESANDBOX_TEMPLATE_ID"),
        timeoutSeconds: retentionMs ? Math.ceil(retentionMs / 1000) : -1,
        metadata: {
          "picloud.managed": "true",
          "picloud.workload": "guest-acceptance",
        },
        allowInternetAccess: true,
        allowPublicTraffic: false,
      });
      allocations.push(created);
      const current = await client.read(created.sandboxId);
      if (!current?.nodeId) throw new Error("Owned Guest fixture node is unconfirmed");
      const vm = { ...created, nodeId: current.nodeId };
      await client.executionTarget(vm.sandboxId, vm.nodeId, vm);
      allocations[allocations.length - 1] = vm;
      const setup = await command(
        vm,
        "install -d -o 1000 -g 1000 -m 0700 /workspace/guest-fixture",
      );
      if (setup.exitCode !== 0) throw new Error("Owned Guest fixture directory setup failed");
      return vm;
    };
    const scope = {
        tenantId: randomUUID(),
        sessionId: randomUUID(),
        piSessionId: randomUUID(),
        runId: randomUUID(),
        turnId: randomUUID(),
        writerId: randomUUID(),
        fencingToken: 1,
      },
      binding = randomUUID();
    async function request(script: string, timeoutMs = 30000) {
      const operationId = randomUUID(),
        toolCallId = randomUUID();
      const input = {
        toolBrokerProtocolVersion: 1 as const,
        type: "tool_sandbox.operation" as const,
        operation: "tool.execute" as const,
        activationId: binding,
        operationId,
        toolCallId,
        toolName: "bash",
        args: { command: script },
        timeoutMs,
        maximumOutputBytes: 51200,
      };
      const handoff: CubeToolHandoff = {
        source: source(),
        operationId,
        executionScopeId: binding,
        writerId: scope.writerId,
        timeoutMs: timeoutMs + 15000,
        payload: {
          toolWorkerProtocolVersion: 7,
          type: "worker.operation",
          attachment: { activationId: binding, toolRoot: "/workspace/guest-fixture" },
          request: input,
          delivery: await issuer.issue({
            operationId,
            expiresAt: Date.now() + timeoutMs + 15000,
            context: {
              scope,
              replyTopic: mailbox.topic,
              toolCallId,
              nativeToolCallId: toolCallId,
              toolName: "bash",
              partition: 0,
            },
          }),
        },
      };
      return { handoff, toolCallId };
    }
    let inspectedVm: CubeSandboxInstance | undefined;
    try {
      await mailbox.start();
      const vm = await create(),
        target = await client.executionTarget(vm.sandboxId, vm.nodeId!);
      inspectedVm = vm;
      const first = await request(
        "printf start >> /workspace/guest-count; touch /workspace/guest-started; sleep 8; printf end >> /workspace/guest-count; printf DONE",
      );
      const result = mailbox.wait(
        first.handoff.operationId,
        first.toolCallId,
        "bash",
        AbortSignal.timeout(60000),
      );
      let early: Awaited<typeof result.result> | Error | undefined;
      void result.result.then(
        (r) => {
          early = r;
        },
        (e) => {
          early = e;
        },
      );
      await client.submitTool(target, first.handoff);
      await client.submitTool(target, first.handoff);
      await expect(
        client.submitTool(target, {
          ...first.handoff,
          payload: {
            ...(first.handoff.payload as object),
            request: {
              ...(first.handoff.payload as any).request,
              args: { command: "printf changed" },
            },
          },
        }),
      ).rejects.toMatchObject({ code: "operation_changed" });
      await until(async () => {
        if (early instanceof Error) throw early;
        if (early?.isError)
          throw new Error(
            "Guest failed before command marker: " +
              JSON.stringify(early.result.content).slice(0, 4000),
          );
        return (await command(vm, "test -f /workspace/guest-started")).exitCode === 0
          ? true
          : undefined;
      }, "command started");
      const killDaemon = async () => {
        const killed = await command(
          vm,
          `node --input-type=module <<'PMA'
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
const db=new DatabaseSync('/run/pi-cloud-executor/state.sqlite');const o=db.prepare('select owner_pid,owner_start from identity where id=1').get();
const f=readFileSync('/proc/'+o.owner_pid+'/stat','utf8');if(f.slice(f.lastIndexOf(')')+2).split(' ')[19]!==o.owner_start)throw Error('daemon identity changed');
process.kill(o.owner_pid,'SIGKILL');db.close();console.log('stopped owned Guest daemon');
PMA`,
        );
        expect(killed.exitCode).toBe(0);
      };
      await killDaemon();
      const recovered = await client.executionTarget(vm.sandboxId, vm.nodeId!);
      expect(recovered.bootId).toBe(target.bootId);
      await client.submitTool(recovered, first.handoff);
      expect((await result.result).isError).toBe(false);
      expect((await command(vm, "cat /workspace/guest-count")).stdout).toBe("startend");
      const stop = await request(
        "echo $$ > /workspace/cancel-pid; touch /workspace/cancel-start; sleep 30; touch /workspace/cancel-finished",
      );
      const stopped = mailbox.wait(
        stop.handoff.operationId,
        stop.toolCallId,
        "bash",
        AbortSignal.timeout(60000),
      );
      void stopped.result.catch(() => {});
      await client.submitTool(recovered, stop.handoff);
      await until(
        async () =>
          (await command(vm, "test -f /workspace/cancel-start")).exitCode === 0 ? true : undefined,
        "cancellable Tool started",
      );
      await client.cancelTool(recovered, {
        source: source(),
        executionScopeId: binding,
        writerId: scope.writerId,
        operationId: stop.handoff.operationId,
      });
      expect((await stopped.result).isError).toBe(true);
      expect((await command(vm, "test ! -f /workspace/cancel-finished")).exitCode).toBe(0);
      expect((await command(vm, 'test ! -e "/proc/$(cat /workspace/cancel-pid)"')).exitCode).toBe(
        0,
      );
      const bg = await request(
        "nohup sh -c 'sleep 3; touch /workspace/background-survived' >/dev/null 2>&1 &",
      );
      const background = mailbox.wait(
        bg.handoff.operationId,
        bg.toolCallId,
        "bash",
        AbortSignal.timeout(60000),
      );
      void background.result.catch(() => {});
      await client.submitTool(recovered, bg.handoff);
      expect((await background.result).isError).toBe(false);
      await client.cancelTool(recovered, {
        source: source(),
        executionScopeId: binding,
        writerId: scope.writerId,
        operationId: bg.handoff.operationId,
      });
      await until(
        async () =>
          (await command(vm, "test -f /workspace/background-survived")).exitCode === 0
            ? true
            : undefined,
        "completed background launch survives Stop",
      );
      const whileDown = await request(
        "touch /workspace/daemon-down-start; sleep 3; nohup sh -c 'sleep 5; touch /workspace/daemon-down-background' >/dev/null 2>&1 &",
      );
      const downReply = mailbox.wait(
        whileDown.handoff.operationId,
        whileDown.toolCallId,
        "bash",
        AbortSignal.timeout(60000),
      );
      void downReply.result.catch(() => {});
      await client.submitTool(recovered, whileDown.handoff);
      await until(
        async () =>
          (await command(vm, "test -f /workspace/daemon-down-start")).exitCode === 0
            ? true
            : undefined,
        "Tool started before daemon loss",
      );
      await killDaemon();
      expect((await downReply.result).isError).toBe(false);
      expect((await client.executionTarget(vm.sandboxId, vm.nodeId!)).bootId).toBe(target.bootId);
      await until(
        async () =>
          (await command(vm, "test -f /workspace/daemon-down-background")).exitCode === 0
            ? true
            : undefined,
        "background completion survives absent service",
      );
      const delayed = await request("touch /workspace/never-started");
      await client.cancelTool(recovered, {
        source: source(),
        executionScopeId: binding,
        writerId: scope.writerId,
        operationId: delayed.handoff.operationId,
      });
      await expect(client.submitTool(recovered, delayed.handoff)).rejects.toMatchObject({
        code: "execution_position_stale",
      });
      expect((await command(vm, "test ! -f /workspace/never-started")).exitCode).toBe(0);
      // Short explicit fixture policy: prove expiry does not consult a busy Tool map.
      const expiring = await create(60000),
        expiringTarget = await client.executionTarget(expiring.sandboxId, expiring.nodeId!);
      const pending = await request("touch /workspace/expiry-start; sleep 120", 180000);
      await client.submitTool(expiringTarget, pending.handoff);
      await until(
        async () =>
          (await command(expiring, "test -f /workspace/expiry-start")).exitCode === 0
            ? true
            : undefined,
        "unfinished Tool before expiry",
      );
      await until(
        async () => {
          const r = await client.observe(expiring.sandboxId, expiring.nodeId!);
          return r.presence === "absent" ? r : undefined;
        },
        "finite retention despite unfinished Tool",
        180000,
      );
      expect((await client.observe(expiring.sandboxId, expiring.nodeId!)).presence).toBe("absent");
    } catch (error) {
      if (inspectedVm) {
        const diagnostic = await command(
          inspectedVm,
          `id; cat /proc/self/cgroup; stat -c '%a %U %n' /sys/fs/cgroup /workspace; ps -eo pid,ppid,stat,comm; node --input-type=module <<'PMA'
import {DatabaseSync} from 'node:sqlite';import{existsSync}from'node:fs';
const p='/run/pi-cloud-executor/state.sqlite';if(existsSync(p)){const d=new DatabaseSync(p);console.log(JSON.stringify({identity:d.prepare('select owner_pid,owner_start,blocked from identity').get(),operations:d.prepare('select id,pid,start,deadline,cancelled,finished from operations').all()}));d.close();}
PMA`,
        ).catch(() => undefined);
        console.error("Owned Guest diagnostics", JSON.stringify(diagnostic));
      }
      throw error;
    } finally {
      const errors: unknown[] = [];
      for (const a of allocations)
        try {
          await until(
            async () => {
              if (a.nodeId && (await client.observe(a.sandboxId, a.nodeId)).presence === "absent")
                return true;
              await client.destroy(a.sandboxId);
              return true;
            },
            "owned allocation cleanup",
            90000,
          );
        } catch (e) {
          errors.push(e);
        }
      await mailbox.shutdown();
      await client.close();
      if (errors.length)
        throw new AggregateError(errors, "Guest acceptance physical cleanup is unconfirmed");
    }
  },
  300000,
);
