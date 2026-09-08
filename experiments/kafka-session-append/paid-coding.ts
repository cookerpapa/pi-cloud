import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { CloudAgentRuntime } from "@pi-cloud/pi-session-postgres";
import { PiCloudApi, newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import type { SessionMetadata } from "@earendil-works/pi-agent-core";
import type { KafkaAckSessionStorage } from "./storage.ts";

type Exercise = (
  meta: SessionMetadata,
  run: (storage: KafkaAckSessionStorage) => Promise<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Paid component test, not the production Worker/SessionStorage cutover.
 * Model code runs only in a disposable real Cube via its authenticated terminal.
 */
export async function runPaidCoding(exercise: Exercise) {
  const env = Object.fromEntries(
    (await readFile("deploy/production/runtime/.env", "utf8"))
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`;
  let cookie = "";
  const fetchApi = async (path: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const response = await fetch(new URL(String(path), base), {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers)), ...(cookie ? { cookie } : {}) },
    });
    for (const value of response.headers.getSetCookie())
      if (value.startsWith("pi_cloud_session=")) cookie = value.split(";")[0]!;
    return response;
  };
  const api = new PiCloudApi(fetchApi);
  const username = `kafka.ack.${Date.now().toString(36)}`;
  await api.registerAccount(username, "Kafka ACK experiment", crypto.randomUUID() + " Aa9!");
  let environmentId: string | undefined;
  let tools = 0;
  const abort = new AbortController();
  try {
    const environment = await api.createDevelopmentEnvironment(
      "Kafka ACK experiment",
      "starter",
      newIdempotencyKey("environment"),
    );
    environmentId = environment.environmentId;
    const terminal = (command: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const target = new URL(`/v1/development-environments/${environmentId}/terminal`, base);
        target.protocol = "ws:";
        const socket = new WebSocket(target, { headers: { cookie } });
        const marker = `ACK_END_${crypto.randomUUID().replaceAll("-", "")}`;
        let output = "",
          ended = false;
        const timer = setTimeout(() => {
          socket.terminate();
          reject(new Error("Cube terminal command timed out"));
        }, 120000);
        const finish = () => {
          const match = new RegExp(`${marker}:(\\d+)`).exec(output);
          if (!match || ended) return;
          ended = true;
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.close",
            }),
          );
          socket.once("close", () => {
            clearTimeout(timer);
            if (Number(match[1]) !== 0)
              reject(new Error(`Cube command exit ${match[1]}: ${output.slice(-1500)}`));
            else resolve(output.slice(0, match.index));
          });
        };
        socket.on("message", (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === "workspace_terminal.ready") {
            const script = `stty -echo\nmkdir -p /home/user/ack-code\ncd /home/user/ack-code\nbash -lc ${quote(command)}\nresult=$?\nprintf '\\n${marker}:%s\\n' "$result"\n`;
            const wire = `bash -lc "$(printf %s ${Buffer.from(script).toString("base64")} | base64 -d)"\n`;
            socket.send(
              JSON.stringify({
                workspaceTerminalProtocolVersion: 1,
                type: "workspace_terminal.input",
                data: Buffer.from(wire).toString("base64"),
              }),
            );
          } else if (frame.type === "workspace_terminal.output") {
            output += Buffer.from(frame.data, "base64").toString();
            if (output.length > 1024 * 1024) {
              socket.terminate();
              reject(new Error("Cube output exceeded test limit"));
            }
            finish();
          } else if (frame.type === "workspace_terminal.error") {
            clearTimeout(timer);
            socket.terminate();
            reject(new Error(`${frame.code}: ${frame.message}`));
          }
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", () => {
          if (!ended) {
            clearTimeout(timer);
            reject(new Error("Cube terminal closed without command completion"));
          }
        });
      });
    const { stdout } = await promisify(execFile)("docker", [
      "inspect",
      "pi-cloud-production-cli-proxy-api-1",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    ]);
    const apiKey = (
      await readFile("deploy/production/runtime/secrets/cli-proxy-api-key", "utf8")
    ).trim();
    const model: Model<"openai-responses"> = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      provider: "deepseek",
      api: "openai-responses",
      baseUrl: `http://${stdout.trim()}:8317/v1`,
      reasoning: true,
      thinkingLevelMap: { off: "none" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    };
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("deepseek", async () => ({ type: "api_key", key: apiKey }));
    const models = createModels({ credentials });
    models.setProvider(
      createProvider({
        id: "deepseek",
        models: [model],
        auth: { apiKey: envApiKeyAuth("Experiment", []) },
        api: openAIResponsesApi(),
      }),
    );
    const proof = await exercise(
      { id: crypto.randomUUID(), createdAt: Date.now() },
      async (storage) => {
        let compactions = 0;
        const rounds: number[] = [];
        const roundDiagnostics: unknown[] = [];
        const marker = {
          summaryContains: [] as boolean[],
          modelContextContains: [] as boolean[],
          finalEchoed: false,
        };
        const run = async (prompt: string) => {
          const start = performance.now();
          const promptsPresent: boolean[] = [];
          const runtime = new CloudAgentRuntime({
            session: storage.asSession(),
            lane: "main",
            authority: { signal: abort.signal, async assertCurrent() {}, async close() {} },
            model,
            models,
            streamFn: (model, context, options) => {
              marker.modelContextContains.push(
                JSON.stringify(context.messages).includes("ACK-CODE-ALPHA"),
              );
              promptsPresent.push(
                context.messages.some(
                  (message) =>
                    message.role === "user" &&
                    (typeof message.content === "string"
                      ? message.content
                      : message.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                          .join("\n")) === prompt,
                ),
              );
              return models.streamSimple(model, context, options);
            },
            systemPrompt:
              "You are testing an isolated coding environment. The working directory is /home/user/ack-code. Use bash for all file/code operations. Implement and run the requested tests; do not ask clarification or use subagents. Preserve user project invariants in summaries.",
            streamOptions: { apiKey, maxTokens: 8192 },
            // Lower the compaction threshold, not the model's real input window:
            // Pi also uses contextWindow to clamp max_output_tokens.
            compaction: { enabled: true, reserveTokens: 112000, keepRecentTokens: 2048 },
            retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
            tools: [
              {
                name: "bash",
                label: "Bash",
                description: "Run a shell command in the isolated Cube working directory",
                parameters: {
                  type: "object",
                  properties: { command: { type: "string" } },
                  required: ["command"],
                  additionalProperties: false,
                } as any,
                async execute(id, args) {
                  assert(
                    (await storage.findRecords({ type: "tool_started" })).some(
                      (r) => r.toolCallId === id,
                    ),
                    "Tool intent was not committed before effect",
                  );
                  tools++;
                  return {
                    content: [
                      { type: "text", text: await terminal((args as { command: string }).command) },
                    ],
                    details: {},
                  };
                },
              },
            ],
            commitCheckpoint: async (operation) => {
              assert.equal(operation.kind, "append_items");
              if (operation.kind === "append_items") await storage.appendItems(operation.items);
            },
            onEvent: (event) => {
              if (event.type === "compaction_end" && event.success) {
                compactions++;
                marker.summaryContains.push(
                  JSON.stringify(event.result).includes("ACK-CODE-ALPHA"),
                );
              }
            },
          });
          const result = await runtime.run(prompt);
          assert.equal(result.kind, "completed", result.error?.message);
          if (prompt.includes("最终回答标记"))
            marker.finalEchoed = JSON.stringify(result.finalMessage.content).includes(
              "ACK-CODE-ALPHA",
            );
          rounds.push(Math.round(performance.now() - start));
          const inspection = await terminal(
            "pwd; python3 - <<'PY'\nimport algorithms as a\nprint('MODULE', a.__file__)\nprint('FUNCTIONS', ','.join(n for n in dir(a) if 'sort' in n or 'search' in n))\nPY",
          );
          const diagnostic = {
            promptPresentAtRequests: promptsPresent,
            inspection: inspection.replace(/.*base64 -d\).*?\n/s, "").slice(-1200),
            stopReason: result.finalMessage.stopReason,
            usage: result.finalMessage.usage,
            marker: structuredClone(marker),
          };
          roundDiagnostics.push(diagnostic);
          console.log(JSON.stringify({ paidRound: rounds.length, ...diagnostic }));
          assert.notEqual(
            result.finalMessage.stopReason,
            "length",
            "Coding response exhausted its output budget",
          );
        };
        await run(
          "创建 algorithms.py，实现 insertion_sort 和 binary_search（已排序数组任意命中下标，不存在返回 -1），加入 unittest 覆盖空数组、负数、重复值、逆序、已排序和随机数组。实际运行测试。保持代码简洁。最终回复项目标记 ACK-CODE-ALPHA。",
        );
        await run(
          "先读取已有 algorithms.py，保留实现和测试，在同一 algorithms.py 中新增名为 heap_sort 的顶层函数，接收列表并返回排好序的列表，同时新增测试，运行原有与新增测试。不要只回复文字。",
        );
        await run(
          "这是前两轮的辅助测试向量记录，不要计算，不要逐条复述，不要调用工具；只回复已收到。继续保留现有代码与项目标记。\n" +
            Array.from({ length: 1000 }, (_, i) =>
              JSON.stringify({
                case: i,
                input: [i, -i, i % 7, 0, i],
                expected: [-i, 0, i % 7, i, i],
              }),
            ).join("\n"),
        );
        await run(
          "读取现有文件，检查实现，实际运行全部测试。保留项目标记，最终回答标记及测试结果。",
        );
        assert(compactions >= 1, "Paid context never triggered native Compaction");
        assert(marker.finalEchoed, "Final answer did not recall the initial project marker");
        const verified = await terminal(
          "python3 - <<'PY'\nimport algorithms as a, random\nr=random.Random(7)\nfor _ in range(100):\n xs=[r.randrange(-30,30) for _ in range(r.randrange(50))]\n assert a.insertion_sort(xs.copy()) == sorted(xs)\n assert a.heap_sort(xs.copy()) == sorted(xs)\n ys=sorted(xs)\n for target in [-100,0,7,100]:\n  i=a.binary_search(ys,target)\n  assert (i == -1 and target not in ys) or (0 <= i < len(ys) and ys[i] == target)\nprint('INDEPENDENT_100_ARRAYS_OK')\nPY",
        );
        assert(verified.includes("INDEPENDENT_100_ARRAYS_OK"));
        const usages = await storage.findRecords({ type: "usage" });
        const tokens = usages.reduce(
          (s, r) => ({
            input: s.input + r.usage.input,
            output: s.output + r.usage.output,
            cacheRead: s.cacheRead + r.usage.cacheRead,
          }),
          { input: 0, output: 0, cacheRead: 0 },
        );
        return {
          roundsMs: rounds,
          tools,
          compactions,
          tokens,
          independent100ArrayChecks: true,
          marker,
          roundDiagnostics,
          projectionStoppedThroughoutAgentRuns: true,
        };
      },
    );
    return { ...proof, acceptanceUsername: username, environmentId };
  } finally {
    abort.abort();
    if (environmentId)
      await api.developmentEnvironmentAction(
        environmentId,
        "release",
        newIdempotencyKey("environment"),
      );
    console.log(
      JSON.stringify({
        acceptanceUsername: username,
        environmentId,
        releaseRequested: !!environmentId,
      }),
    );
  }
}
