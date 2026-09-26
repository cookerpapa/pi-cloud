# CloudAgentRuntime 与原生 Pi 执行边界审查

日期：2026-09-26。基线：`176bf2e574b616c5ea7e4229dcf902607b244ef9`。
状态：本轮审查完成；以下修复尚未实施。本轮仅增加报告、复现脚本与待办。

## 范围与结论

主基准为实际安装的 Pi **0.84.1**：原生 `Agent`、`agent-loop`、
`AgentSession`、Session/Record、上下文构建、Compaction 与供应商消息转换。
云端范围为 `CloudAgentRuntime`，以及其调用方、事件适配、采样边界、
原生 Writer 和控制消息接收链。本轮不是再次进行全仓审查，也不涉及升级或部署。

**公开 SDK 接口的使用方式成立，但自有运行时对会话执行规则的掌握偏多。**
发现四组可复现差异：收尾时接受却不消费的控制消息、跨成功响应累计的重试预算、
压缩后使用旧 usage 再次触发压缩，以及取消退避时的延迟和错误重试完成标记。
优先级为 CR-01/P1、CR-02/P2、CR-03/P2、CR-04/P3。

这不意味着应该删除整个封装。原生 Agent 已负责模型/工具循环、参数校验、
工具执行顺序和 before/after hooks；云端确认、租约失效、远程执行及未知效果恢复
仍需要 PiCloud 承担。重点是减少并校验外层自有执行规则。

## 设计依据与验证方法

重新核对了长期开发会话中 9 月 4 日和 9 月 21 日关于 Harness、Lane、
异步事件监听和云端持久化的讨论，并以当前 ADR 校准历史结论：

- [ADR-0144](../adr/0144-subagent-pi-session-lanes.md)：一个物理 Session、多 Lane，
  当时高层 Harness 未完成，因此继续使用公开 Agent。
- [ADR-0148](../adr/0148-two-phase-tool-effect-checkpoint.md)：完整 Assistant 与
  已校验 Tool intent 分别确认，后者确认前不能开始工具效果。
- [ADR-0161](../adr/0161-kafka-native-session-commit.md)：Worker 分配原生顺序、
  Kafka ACK 后更新可见状态，PG 异步投影；不回到逐 Step PG 回执。
- [ADR-0176](../adr/0176-bounded-context-overflow-recovery.md)：有界溢出压缩，
  不重新提交用户输入、不重执行整个 Run、不重放已完成工具。
- [ADR-0185](../adr/0185-native-record-and-invocation-contract.md)、
  [ADR-0187](../adr/0187-model-retry-ownership.md)：原生记录、调用身份、hooks
  与模型重试的既定职责。

对照探针使用真正的 Pi `Agent` 和 `AgentSession`，仅将模型流、认证返回值及
会话存储替换为本地测试数据。原生 `AgentSession` 使用内存 SessionManager，
云端使用公开的内存 Session；两者保留各自会话格式，比较相同逻辑场景的行为。
所有模型响应均为脚本生成，标识为 GPT-6 Luna；窗口数值是测试参数，不是模型规格。
没有付费请求、用户扩展、真实 shell 工具、生产 PG/Kafka/Cube 或故障注入。

已有测试另行覆盖真实 Cloud Runner、原生 Writer、PGlite/投影、模拟 HTTP 模型服务、
Tool ACK 与故障传播。报告区分探针已观察的结果和根据生产调用链推导的影响。
源码散列与原始结果见 [探针记录](cloud-agent-runtime-review-20260926-probes.json)。
没有将历史会话文本复制进仓库。

## 职责对照

| 行为 | PiCloud 当前实现 | 评价 |
| --- | --- | --- |
| 请求模型、选择并执行工具、继续推理 | 原生 `Agent` 和 `agent-loop` | 已复用，无另写工具选择循环 |
| 工具校验、并行/顺序、before/after hooks | Pi 公共接口，云端包装 `execute` 写 intent | 边界成立，after-hook 结果成为 canonical |
| 首条用户消息 | 先追加 Session，再调用 `continue()` | 有意设计；再次 `prompt()` 会重复提交输入 |
| 普通 steer/follow-up | 原生队列；外层负责持久输入和生命周期 | 收尾准入与队列消费存在 CR-01 |
| 模型失败重试 | Pi 错误分类，加已记录的流中断分类；外层管理预算/退避 | CR-02、CR-04 |
| 上下文与压缩 | 复用 `buildSessionContext`、`prepareCompaction`、`compact` 等；外层决定时机 | 压缩边界的新鲜度判断缺失，CR-03 |
| 记录与显示确认 | 异步 Agent listener + `commitCheckpoint` | Pi 明确等待 listener，符合公开接口合同 |
| Writer/租约失效 | 注入 authority，Writer 不确定写入后停止全部相关 Lane | 云端必要职责；不应交给模型重试处理 |
| 中断恢复 | 只对已写 intent 的未完成工具记录 UNKNOWN | 有意差异；没有盲目重执行旧工具 |
| 模型/工具配置变化 | 每个 accepted Turn 固定配置，下一 Run 再改变 | 当前产品合同，不能照搬本地交互式热切换 |
| 图片 | 外部附件 codec 还原为原生图片，再进入 Agent | 本轮未发现需要新增循环逻辑的证据 |
| 扩展加载 | 可信代码拥有 hooks，用户/项目执行扩展未开放 | 当前安全边界；自动资源加载和审批 UI 仍是独立功能 |

## CR-01 · P1 · 收尾窗口可以成功接收控制消息，但不再消费

位置：
[执行循环的结束判断](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L595)、
[运行时控制入口](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L769)、
[TurnRunner 控制入口](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts#L457)。

`#inputAgent()` 只检查实例是否存在、是否已请求取消与 authority。
底层 Agent 发出 `agent_end` 后，外层仍持有该实例；还可能正在等待
`operation_finished` 写入确认。此时 `steer()`/`agentInput()` 可以返回成功，
但正常完成分支直接退出，没有再次检查 `agent.hasQueuedMessages()`，最终丢弃实例。

已复现两种窗口：

1. 在 `agent_end` 回调中分别发送人类 steer、Agent steer、Agent follow-up。
   三者均返回成功；云端只有一次模型请求，历史与模型输入均没有新增消息。
   原生 AgentSession 在相同事件中接收 steer 后继续执行，总计两次请求并消费消息。
2. 用存储端口延迟 `operation_finished` 的确认，在这个等待期间发送 steer。
   云端仍返回成功，最终 Run 为 completed，消息仍未消费。

原生参照：`pi-coding-agent/dist/core/agent-session.js` 的
`_handlePostAgentRun()` 在结束后检查队列；`pi-agent-core/dist/agent.js` 的
`continue()` 支持在最后一条为 Assistant 时消费已排队的 steer/follow-up。
所以无需另写 Agent Loop 才能处理此情况。

生产影响推导：[TurnSteeringService](../../packages/control-plane/src/turn-steering-service.ts#L186)
在 backend 返回成功后将请求设为 completed，并返回 delivered。
[Supervisor](../../packages/sandbox-supervisor/src/agent-run-supervisor.ts#L905)
只要外层 Run 尚未结束就能调用该入口。因此正常收尾时也可能出现
“提示已送达，但 Agent 永远没看到”。本轮直接复现的是运行时入口；没有在真实 HTTP/PG
上制造此竞态。Subagent 邮箱另有 consumed 标记和后续 Run 重投逻辑，不能由此断言
所有 Subagent 输入永久丢失。正常产品 follow-up 的 PG 排队路径也不等同于此入口。

建议：将输入准入与终止判定收敛到一个明确的生命周期边界；已接受且仍需消费的
原生队列应在当前 Run 内继续，进入最终关闭后应明确拒绝。保持现有持久输入、
幂等身份和原生队列，不新增调度器，也不重新执行整个 Run。

## CR-02 · P2 · 成功回答后进入 follow-up，重试预算没有重置

位置：[重试计数的重置条件](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L569)、
[预算检查](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L600)。

当前 `retryAttempt` 只在成功 Assistant 的 `stopReason === "toolUse"` 时立即清零。
成功的普通回答 `stop` 如果接着消费 follow-up，底层 Agent 继续循环，外层尚未返回，
旧计数会被带到新的模型请求。

探针使用与生产相同的 `maxRetries=2`，缩短退避以加速测试。响应序列是：
第一次请求失败两次后成功回答；收到 follow-up；下一请求首次失败、随后可成功。
云端在第 4 次请求后判定重试已耗尽并失败；原生 AgentSession 重置成功 Step 的计数，
第 5 次请求成功。生产的项目验证 follow-up、运行中的 Agent 消息都可以跨越该边界。

原生参照：`AgentSession._handleAgentEvent()` 在成功 Assistant 的 `message_end`
立即结束此前的 retry 并重置计数，不只检查 `toolUse`。

这里的变量是运行时预算 `retryAttempt`。此前 PI-01 修复的是原生 Record 中
`assistantAttempt` 的 Step 序号，后者已经正确重置；两者不是同一个问题。
ADR-0187 也规定重试属于未完成的 sampling Step，而非整个 Run 的累计失败额度。

建议：以模型 Step 的实际成功边界重置重试状态，覆盖普通回答后继续、
工具后继续以及排队输入继续；保留已完成工具不重放的约束。

## CR-03 · P2 · 最新 Compaction 保留的旧 usage 会触发多余压缩

位置：[压缩触发判断](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L847)。

`estimateContextTokens()` 会优先采用最后一个有效 Assistant 的 provider usage。
Compaction 的 retained tail 可以保留该 Assistant，但其中的 usage 描述的是
压缩前的整个请求。当前触发判断没有识别 usage 位于最新压缩之前。

探针构造一个已压缩的 Session：短摘要和短保留消息，结构估计约 15 tokens，
保留 Assistant 的旧 usage 为 9,501 tokens；测试窗口 10,000、reserve 1,000。
新输入到来后，云端额外生成了一次摘要；原生 AgentSession 对照没有再次压缩。
这模拟了压缩完成、尚无新成功模型响应时发生恢复或继续的状态。

原生参照：`AgentSession._checkCompaction()` 检查最新 Compaction 与 Assistant/usage
的时间关系，避开旧 usage。云端源码在计算压缩后的**显示数值**时已经注明这个风险
并改用结构估计（约第 969 行），但触发下一次压缩的判断仍使用旧 usage。

影响是无必要的摘要请求、延迟，以及反复重新概括的风险；本探针未证明历史内容实际丢失。
结构估计也不等于供应商的精确 tokenizer 数值。

建议：让阈值判断识别最新原生 Compaction 边界，只信任该边界之后的新 usage；
其他情况使用已有 Pi 估计能力。保持明确 context-overflow 的独立恢复路径，
不通过调大窗口或禁用压缩掩盖问题。

## CR-04 · P3 · 取消无法立即结束重试退避，且被标成重试成功

位置：[退避等待](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L676)、
[取消入口](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L806)、
[重试结束事件](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L620)。

`abort()` 设置取消标记并调用 `agent.abort()`。模型错误后的退避发生在底层 Agent
已经停止时，`agent.abort()` 此刻没有活动调用可取消；等待仅监听 authority.signal。
用户取消不会使共享 Session 的 authority 失效，因此仍会等完整个退避。

探针在 500ms 退避开始约 10ms 后取消：云端约 0.49 秒后才结束，
原生 AgentSession 通过独立 retry AbortController 很快结束。
两边都只有一次模型请求；云端最终结果仍为 aborted，没有观察到取消后的额外请求。
现行默认重试退避为 500/1,000ms，本问题不是无限等待或已证实的工具越权。

此外，外层以 `stopReason !== "error"` 判断 retry 成功，把后续的 aborted
也记成 `auto_retry_end.success=true`；原生对照为 false。
当前公开事件适配器忽略 `auto_retry_end`，所以这里证明的是运行时事件错误，
不是已证实的网页成功状态误报。

建议：为单 Run 的取消覆盖退避等外层等待，并对 retry 结果区分成功、失败和取消。
不要通过关闭共享 Session authority 达到取消效果；最后记录写入与其他 Lane 仍需要它。

## 已核实、应保留的边界

- `Agent.subscribe()` 明确等待异步监听器，`state.messages` 是公开允许赋值的状态。
  在这些接口上做持久化或重试不属于调用私有实现；原生 AgentSession 自己也使用这些接口。
- 完整消息与 usage、已校验 intent、最终 after-hook Tool Result 的确认边界应保留。
  Writer 在不确定 publication 后 poison 并停止相关 Lane；不能把这种错误降格成模型重试。
- 恢复探针包含两个原始工具调用，但只有一个已写 intent。只对后者持久化 UNKNOWN；
  未开始的调用由 Pi 的 provider 消息转换补错误占位，不会被误认成已经执行。
  这遵守 ADR-0148，不能把所有原始 Tool Call 都补成 UNKNOWN 或自动重放。
- 固定 Turn 配置、持久输入、租约/fence、模型并发许可、远程 Tool 与图片附件端口，
  都有明确云端理由。当前没有必要为“低耦合”另建通用 Agent 框架。
- `CloudAgentRuntime` 已暴露 before/after hooks，生产 TurnRunner 尚无统一的审批策略
  注入配置。当前未承诺审批产品或加载用户扩展；未来接入仍须完成生产装配与取消/持久化
  验收，不能把已有 hook 测试说成审批功能已经可用。

## 复用方向

0.84.1 的 `AgentHarness.prompt/compact/resume` 仍为未实现接口，但它的
`AgentSession` 是可运行的，本轮已作为对照执行。后者依赖本地同步 SessionManager、
既有会话格式与资源加载，不能直接替换我们异步确认、多 Lane 的 SessionStorage。

本地前向参考 `~/pi-latest` 为 **0.86.1 / c7cdb460aa8a0cebef3446c4166729b8a0d97ead**。
其 `harness/runtime/lane.ts` 已有 accept/drive 驱动的 prompt/compact/resume 实现；
不能把 0.84.1 的“未实现”结论延伸到这个版本。
该参考也改变了 Session 的 mutation/context 接口，仍有未实现的 `watchSession`。
本轮仅阅读相关源码，没有运行该版本的存储、租约、无重放或升级迁移合同；
这是重新评估采用高层 Harness 的依据，不是“可以直接升级替换”的验收。

近期先修已复现的行为差异并建立对照测试；随后独立评估新 Harness 是否能通过现有
PiCloud 端口承接通用生命周期。单纯把 1,204 行运行时拆成更多文件不会消除语义耦合。
`commitCheckpoint` 同时承接原生批量写入与源事件、其类型来自 PG 适配包，也值得在
该评估中收窄职责；当前只有类型依赖，不代表 Agent 内执行了 SQL 或新增持久化权威。

## 验证与复现

- 执行相关现有测试：**7 个文件，145 项通过，0 失败**。
  第一组 89 项：cloud-agent-runtime、cloud-agent-contract、pi-agent-event-adapter、
  pi-sampling-step。第二组 56 项：pi-cloud-turn-runner.integration、trusted-remote-tools、
  native-session-writer。
- 新探针：**6 个场景完成**，四组差异均观察到，原生对照断言通过；
  UNKNOWN/provider 占位的恢复检查通过。
- 现有测试通过不覆盖新增的组合边界。后续修复应将这些场景转成相应包的回归测试。
- 没有修改生产实现、依赖锁、数据库、部署或供应商配置；没有进行线上故障测试。

从安装好锁定依赖的 checkout 运行：

```bash
node --import tsx scripts/review-cloud-agent-runtime.mjs
```

[脚本](../../scripts/review-cloud-agent-runtime.mjs) 输出 JSON。
退出码 0 表示探针和原生对照正常完成；`findingsObserved` 表示仍观察到的差异，
**不表示一致性检查全通过**。它不是把错误行为固化成正确结果的常规测试。

现有测试的精确复现命令：

```bash
npx vitest run packages/sandbox-supervisor/test/cloud-agent-runtime.test.ts packages/sandbox-supervisor/test/cloud-agent-contract.test.ts packages/sandbox-supervisor/test/pi-agent-event-adapter.test.ts packages/sandbox-supervisor/test/pi-sampling-step.test.ts --maxWorkers=2 --testTimeout=15000 --hookTimeout=30000
npx vitest run packages/sandbox-supervisor/test/pi-cloud-turn-runner.integration.test.ts packages/sandbox-supervisor/test/trusted-remote-tools.test.ts packages/pi-session-postgres/test/native-session-writer.test.ts --maxWorkers=2 --testTimeout=15000 --hookTimeout=30000
```
