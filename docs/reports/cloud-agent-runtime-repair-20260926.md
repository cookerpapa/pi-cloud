# CloudAgentRuntime 生命周期修复与输入功能现状

日期：2026-09-26。实现：`ac500bda075c865acefe324390daebd967090f97`；
集成测试配置修正：`58ce256cafcc9f730b9b30903ac6407d5aa06faa`。
依据：[审查](cloud-agent-runtime-review-20260926.md)、
[ADR-0193](../adr/0193-native-run-lifecycle-boundaries.md)。

## 修复结果

| 问题 | 当前行为 | 验证 |
| --- | --- | --- |
| CR-01 收尾输入丢失 | 成功的原生循环结束后继续消费已接受队列；最终空队列判定与关闭准入之间没有 await。写最终记录期间的新输入明确拒绝 | agent_end 的四种输入、最终 append 等待、异步去重读竞态、真实 TurnRunner 的 target-unavailable 映射；PG 和原生 Writer 两种路径 |
| CR-02 重试预算跨成功响应累计 | 普通回答与工具回答成功后均重置 sampling retry；一个 Run 的后续输入获得自己的 Step 重试预算 | 两次失败后成功、follow-up 再失败后成功，总计五次模型请求；原生 Record attempt 保持 `[1,2,3,1,2]` |
| CR-03 旧 usage 再次触发压缩 | 通过最新 Compaction 后的 Entry 判断 usage 新鲜度，复用 Pi 的 `getLastAssistantUsage` 与 token 估计函数 | 旧 usage 不触发额外摘要；压缩后新的有效 usage 和足够大的新输入仍触发压缩；不依赖供应商时间戳 |
| CR-04 取消退避与成功标记 | Run-local AbortSignal 立即结束退避，利用原生 abort 路径完成取消，retry end 为非成功 | 假时钟验证无需推进 50 秒退避，实际对照约 1ms 完成；取消后没有额外模型请求，共享 authority 与 sibling Run 可用 |

Pi 仍为 0.84.1；没有改动 Agent Loop、数据库 schema、消息协议、Provider Gateway、
Cube guest 或 UI。Tool intent ACK、after-hook canonical 结果、租约/封口和 UNKNOWN
恢复保留。关闭输入的错误沿现有管理通道映射为 `steer_target_unavailable`。

## 验证范围与限制

- 全仓类型检查通过；修改测试配置后再次通过 sandbox-supervisor 类型检查。
- 全仓工作区测试首次执行有 **1,114 项通过、116 项 opt-in 跳过、1 项失败**。
  唯一失败是新增集成 fixture 漏填模型 contextWindow，导致进入不属于该场景的摘要流程。
  补齐窗口/输出配置并确保失败也关闭模拟服务器后，相关两个测试文件 **31/31** 通过。
  运行时实现未因这个 fixture 失败而更改。
- 原全仓命令因该失败退出 1，未整体重跑；保留其余通过结果并结合定向复测，
  最新工作区结果为 **1,115 项通过、116 项跳过**。另行执行 acceptance helpers **35/35**，
  合计 **1,150 项通过**，不重复计算定向复测的重叠用例。
- [六组原生对照](cloud-agent-runtime-repair-20260926-probes.json)全部完成，
  `findingsObserved=[]`。原审查的失败数据保留在原文件，不覆盖历史证据。
- [故障矩阵](cloud-agent-runtime-faults-20260926.json) **53/53** 通过，包含新增五项
  生命周期检查，以及独立 PostgreSQL 上的原生并发/附件合同。
  临时数据库与生产隔离。矩阵在提交前的工作区启动，因此记录的基线为 `176bf2e5`、
  `dirtyWorktree=true`；修复探针保存的实现 SHA256 可核对最终源码。
- 文档、格式、运行时间/模板保留策略、Worker 镜像依赖闭包检查通过。

上述故障矩阵是定向注入测试，不是生产故障实验；没有据此增加多机 HA 或物理执行 fencing 的承诺。

## 本地部署与实际运行

确认生产没有 queued/running/settling/cancel_requested Run、未释放 lease 或未封口
Session 后，仅重建并更新两个 Compose Worker。两者镜像 revision 均为 `ac500bda`，
health 均通过。控制平面、Broker、Gateway、Web、PG、Kafka、Cube 模板未重建。
`58ce256c` 只修正测试 fixture，不包含需另行部署的运行时代码。
[部署核对](cloud-agent-runtime-rollout-20260926.json)确认两个容器的运行时文件 SHA256
均与仓库一致，实测清理后未完成 Run、未释放 lease、未封口 Session 均为零。

[GPT-6 Luna 实测](cloud-agent-runtime-live-20260926.json)：

1. 在独立测试 Workspace 中执行一次 `bash` 等待/输出命令，保持文件不变。
2. 第一轮仍在执行工具时，第二条输入保持 queued；取消这条 queued Turn 返回 **409**。
3. 向第一轮发送带随机标记的 steer，接口返回 delivered，最终回答确实包含标记。
4. 第一轮完成后，第二轮执行并返回独立标记。两个 Run 均 completed。
5. 测试会话归档，测试 Workspace 提交释放。

这个实际运行验证覆盖正常远程 Tool、steer 与后续 Run 排队。四种边界差异由上述
确定性对照和回归测试验证，没有声称真实模型恰好触发了收尾竞态或重试退避。

可重复运行：

```bash
node --import tsx scripts/review-cloud-agent-runtime.mjs
PI_CLOUD_LIVE_RUNTIME_CHECK=1 node --import tsx scripts/run-live-runtime-lifecycle-check.mjs
```

第二条会使用真实 Luna、创建测试 Workspace，并归档/释放自身资源。

## follow-up 与 steer 的现有设计

| 操作 | 当前支持 | 消费时机 |
| --- | --- | --- |
| 运行中按 Enter 排队 | 支持 | 输入先持久化为 PG Turn/Run，按 mailbox 顺序等待前驱封口，再由 Worker 领取 |
| 输入草稿后点击“引导” | 支持 | 经持久控制请求与 Worker HTTP 进入 Pi steer 队列，当前模型响应和该批工具结束后、下一次模型请求前消费 |
| 同一 Run 内 native followUp | 内部支持 | Pi 准备停止且没有优先的 steer/工具继续工作时消费；用于 Agent 消息和验证提醒 |
| 停止当前任务 | 支持 | 取消 active Turn，不逐条撤销后面的 queued Turns |
| 单条 queued 消息取消/删除 | 不支持 | 当前取消 API 要求目标 Turn 为 running，实测 queued 返回 409 |
| 已排队消息编辑、上下移动、转为 steer | 不支持 | 没有相应 API 和界面 |
| 已发送 steer 的单条撤回 | 不支持 | 当前接口不提供逐条 recall |

原生队列由 Pi 在循环边界检查；网页排队由 PG readiness 与 Worker 领取触发。
它们都不要求模型自己查看消息队列。网页 queued 输入不会在每个 sampling Step
结束后插入当前 Run，也不等同于原生 `Agent.followUp()`。

OpenAI 官方文档确认桌面端待发队列支持编辑、重排、发送和删除：
[Steering and queuing](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)。
用户提出的这组产品能力已单独记录在 BACKLOG；需要先定义待发输入的可变阶段、
开始执行后的冻结边界，以及编辑/转 steer 与执行领取的竞态。本次没有新增该功能。
