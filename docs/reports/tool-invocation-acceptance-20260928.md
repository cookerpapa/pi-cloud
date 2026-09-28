# Tool 意图与命令合并：实现与验收

日期：2026-09-28。决定：[ADR-0198](../adr/0198-atomic-tool-invocation.md)。
运行代码：`38a4885296e5770103c129b7bb969660d465b254`。
状态：实现、匹配部署、离线验证和真实 GPT-6 Luna/Cube 验收均完成。

## 实现与执行边界

完整 Assistant 回复和用量仍先获得 Kafka ACK，再由原生 Pi 0.84.1 完成工具查找、
参数准备/校验和 before-tool 钩子。固定 `read/write/edit/bash` 的远程适配器随后准备
Cube 绑定、执行描述和回复回调；Runner 把 `tool_started`、公开开始事件和执行描述
放入一条 `tool_invocation`，共用一次 Kafka 提交。

命令复用同一条意图中的 effectiveArgs、原生 Tool ID/name 和 result Entry identity，
没有第三份参数正文。360,000 字符的写入参数测试仍适配现有 900 KiB 上限。
Session writer 继续独占原生序号；没有修改 Pi Agent Loop、添加效果账本或兼容发布路径。
固定工具的独立 `tool.execute` 发布入口会拒绝调用。

Projector 先应用原生意图，再确认单调 Kafka dispatch commit，最后把展开的既有命令
交给 Broker。Broker 独立授权、租约/fence、Guest 协议和原生结果 after-hook 保留。
可信平台工具、子任务控制和 workflow 脚本仍有各自真实的效果边界，本次合并针对四个
完整远程文件/命令工具。

准备 Cube 可以产生基础设施效果，但不会执行用户工具。正式工具开始事件在准备完成
后出现；不能把其时长直接与原先包含准备等待的数值比较。本次证明发布次数收敛，
没有给出脱离模型、存储和部署条件的延迟百分比。

## 失败与取消

- 校验或前置钩子拒绝、准备失败：没有执行意图和派发命令，原始模型回复仍在。
- 进入发布队列前取消：不提交命令；等待 Session writer 时取消也不占原生序号。
- 已提交后取消：可能与派发竞争，即使 Worker 尚未收到 ACK；不声称能撤回日志。
- 发布/ACK 不确定：共享原生 writer 停止继续写入，不重排序号、不重新发布命令。
  冷恢复对有意图而无可靠结果的工具产生 UNKNOWN。
- 原生投影或 dispatch commit 失败：不派发；回放可重建历史，但不能重复发出已经
  提交过派发位置的命令。commit 成功到实际派发之间崩溃，仍可能遗漏执行并成为 UNKNOWN。
- 回调在成功、准备后取消、发布失败和提前到达的回复等出口都清理；Pi 后置钩子的
  最终结果才进入原生日志。

## 验证

[逐文件验证和源码摘要](tool-invocation-verification-20260928.json)：全仓 `npm run check`
通过，1,253 项通过、124 项按环境跳过。随后在隔离真实 PostgreSQL 上补跑 28 个文件，
200 项全部通过；替换相应文件结果后，211 个文件合计 **1,374 通过、3 项配置性跳过**，
没有重复计数。余下是 Kafka topic policy 和两个 Cube provider 的独立 opt-in 用例。
全工作区类型检查、构建、格式、文档、运行策略、镜像闭包和构建上下文检查通过。

[故障矩阵](tool-invocation-faults-20260928.json) **80/80**。新增覆盖复合调用的投影失败、
commit 失败、封口、rebalance、历史回放与取消排队写入。原生 Runner 组合测试还覆盖
完整回复 ACK、校验/钩子拒绝、提前回复、ACK 丢失后的冷恢复、顺序/并行工具、重复
provider Tool ID 和 after-hook 结果归档。

[真实文件工具验收](tool-invocation-tools-20260928.json)：GPT-6 Luna 三轮、13 次完整工具
调用全部成功，包含 write/read/edit/bash、1.5 MB 输出的原生截断、`/tmp` 和符号链接。

[真实重启与 Kafka 核对](tool-invocation-live-20260928.json)：另一轮 Luna 只执行一次 Bash，
先 fsync 写下 `once`，再等待 40 秒。通过 Workspace API 确认效果发生后 SIGKILL Projector，
重启窗口约 14.6 秒；最终工具成功、计数仍为一行。四个 Run 的 Kafka 数据共有 **14 条
tool_invocation、0 条独立命令、0 条独立固定工具意图**，且完整 Assistant 均先出现。
这证明本次受控重放场景，没有把它扩张为任意 shell 的 exactly-once 保证。

## 部署与清理

[匹配切换记录](tool-invocation-rollout-20260928.json)：Control Plane、两台 Worker、Broker、
Web 和 bootstrap 使用上述版本；五个应用实例健康。切换前保存私有 PG 备份。
1,100 条既有原生日志切换前后正文摘要均为 `04abefe61fbc94a02a31c77f94f2c624`。
没有数据库迁移，Cube Guest 身份仍为 `dbcdd74b623a27ffbdf266c706e2e09331c0532c`。

[清理记录](tool-invocation-cleanup-20260928.json)：两个测试 Workspace 的字节存储均已
purge，临时 PostgreSQL 已删除；未结束 Run、当前 owner、未封口 Run 和未结束原生
operation 全部为零。验收历史按既有归档合同保留。
