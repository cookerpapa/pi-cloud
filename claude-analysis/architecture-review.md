# PiCloud 六条主线架构审查

日期：2026-09-20。代码基线：`5d1e8bf5`。这是接续 Claude 审查思路的首轮、有证据的架构分析，
不是“全仓逐行阅读完成”的声明。未改业务代码、未部署、未调用付费模型、未修改生产数据。
读了生产数据库 catalog 核对关系；实验只启动本机临时 HTTP 服务并注入假上游。
保留多 Worker、多租户、多 Lane 和后续扩展目标；不把此前分工提示中的“1～5 Worker、10～100 用户”
擅自替换成产品的新容量目标，也不把局域网等同于可以忽略故障正确性。

## 总结

**主链路有明确理由，真正的收缩空间集中在旧控制路径、失去闭环的计费结构、运行包边界和过细的数据库往返。**
不建议再换消息中间件，也不建议因为私有部署就删除封口、Session 所有权或副作用 UNKNOWN。
优先删除有证据的遗留，再调整事务内的查询组织；不要把一次清理升级成下一轮全系统重写。

分类：A＝可复现错误/明确风险；B＝可收缩的实现或职责；C＝有成本的合理取舍；D＝应保留的合同。
源码位置对应本次基线；后续重构可能改变行号。
获批局部修复及当前验收状态见 [9 月 21 日报告](../docs/reports/review-repair-20260921.md)。
本文保留修改前的判断与边界，不再作为当前待办清单。

| 优先级 | 分类 | 结论 | 证据强度 |
| --- | --- | --- | --- |
| P1 | A | Model Gateway 读请求体期间撤销授权后仍可发上游请求 | 本机确定性交错实验复现 |
| P2 | A | 同处请求计数检查可被两条并发请求越过 | 本机假上游复现，limit=1 而实际=2 |
| P1 | B | 生产 Steer 已用 HTTP，旧 WebSocket Steer fallback 仍挂在运行时 | 从 main 到 factory、service fallback 的完整调用链 |
| P1 | B | 计费表/字段失去正常写入闭环，仍有初始化和回收 | 全应用源码/脚本引用盘点及 native usage 写入核对 |
| P1 | B | 每条消息排他锁 Project/环境版本，造成跨 Session 的受理串行化 | 当前 SQL，未做新并发性能试验 |
| P2 | B | runtime-core 依赖具体 Pi Runner，连带污染 Control Plane 运行包 | package 图、实际 import、Docker COPY |
| P2 | B | 测试假模型嵌在生产 Runner，而非通过测试注入 | 正常生产依赖及分支源码 |
| P2 | C/B | native log 与查询表保存两份完整 payload，投影又有较多 SQL 往返 | 直接检查批量投影实现；磁盘占用未重新测量 |
| P2 | B | 同组故障用例反复启动 Vitest/数据库；依赖硬化维护面较大 | CI 和脚本调用链 |
| P3 | B | Workspace/Worker/Attempt 等历史命名仍误导理解 | 确认仍有活调用，不能把名字旧等同于功能死 |

## 1. Run、SQL 与调度

### 当前必要语义

```text
接受消息事务 → ready Run → Worker 本地容量 → 原子领取/Session 租约
                                                  ↓
                                               Agent Loop
                                                  ↓
完成/中断 → 封口请求 → Kafka → 投影提交 → 下一条消息 ready
```

当前没有 Temporal，也没有 PG 槽位计数或独立 RunAttempt。一个物理 Session 的多 Lane 共用一个
Worker/Lease；Run 是任务身份。Worker 直接领取 PG 队列，不经过另一个 HTTP 派发服务。

正常弹性路径的 SQL 账单（不含 API 鉴权、上下文恢复、通知监听、异常和模型/工具调用）：

| 阶段 | 高层 SQL 往返 | 内容 |
| --- | ---: | --- |
| 接受输入 | 8 | BEGIN；Session/幂等；Workspace SHARE；模型配置；Project UPDATE 锁；环境版本 UPDATE 锁；组合写 Turn/Run/mailbox；COMMIT |
| 新 owner 领取 | 10 | BEGIN；ready 候选/上下文；固定配置；物理 Session 锁；产品 Session 锁；Worker SHARE；租约读取；租约/epoch 写；组合运行状态/发布身份写；COMMIT |

依据：[接受路径](../packages/control-plane/src/control-plane-store.ts#L1324)、
[领取路径](../packages/runtime-core/src/run-executor.ts#L532)、
[计数回归](../packages/control-plane/test/atomic-worker-admission.postgres.test.ts#L286)。
18 次不是 18 次 fsync：这是两个事务。共享已有租约、独享开发机、幂等重放等路径的次数不同。

### B：环境配置更新职责侵入消息受理

[activeEnvironmentForRun](../packages/control-plane/src/control-plane-store.ts#L1756)
先锁 Project，再锁 active environment，最后通常只是发现镜像没有变化。
不同会话共享一个 Project 时，这两把排他锁使消息受理互相等待。它不是用户要求取消的文件写互斥，
但仍然是同一 Workspace 多会话在输入路径上的额外串行点。

建议把“匹配当前版本的普通读取”与“镜像变化后的版本更新”分开；普通读取保留必要的共享保护，
真正更新才持有 Project 排他锁并重新读取。模型配置/Workspace 的固定 ID 读取也可评估合并。
不能直接去掉所有锁：删除、版本切换和同时创建新版本的交错必须验证。当前只是优化方案，
没有声称已经减少到 16 或 14 次，也没有承诺端到端一定同比变快。

### B/C：领取中的层间重复读取

候选查询已读取 Session 元数据，租约协调器又 `selectAll().forUpdate()`：
[coordinator](../packages/runtime-core/src/session-lease-coordinator.ts#L310)。
锁本身承担和取消/归属变更的协调；重复取整行不天然必要。
可以把已锁定事实在同一个事务内传递，把状态约束收敛到最终条件写入。
不能以进程缓存替代这些事实，也不能把“锁前读取”和“锁后新快照读取”无条件揉成一个 SQL。

结束阶段也有一个更直接的候选：[releaseIdleSessionLease](../packages/runtime-core/src/session-lease-release.ts#L40)
在持有物理 Session 锁时先查兄弟任务，再 UPDATE 释放。可用带 `NOT EXISTS` 条件的 UPDATE
减少一次往返，仍保留兄弟 Lane 存活时不释放租约的语义。

### D：不要借清理删除这些机制

- `ready_at` 负责同 Lane 的排队依赖；Session owner 负责多 Lane 共同归属，不能互相替代。
- PG 原子领取与 Lost COMMIT 确认不是防恶意用户，而是防重复执行。
- LISTEN/NOTIFY 是唤醒提示，定时扫描是丢提示/重连的恢复路径；不构成两个调度器。
- child Loop、family slot、model permit、Cube capacity 分别约束不同资源，不是四份同一计数。
- 控制请求重试、模型采样 attempt 与已删除的 RunAttempt 不同，不应批量删除所有 attempt 字样。

## 2. Kafka、投影与 SSE

### 数据交接不是“每 token 都查 PG”

[SessionProjector](../packages/runtime-core/src/session-projector.ts#L74)
使用有界 publication cache、执行边界缓存和 live tail。首次 Run 的归属/恢复位置需要 PG；
缓存命中的普通文本 delta 不插入 PG，也不刷新每 delta 的 PG offset。
完整语义条目和封口才提交持久投影。封口会查相应 Outbox 请求，不是所有事件都查 Outbox。

| 记录 | Kafka | PG 与后续动作 |
| --- | --- | --- |
| 稳态 text delta | Worker durable append | 内存 tail/SSE；通常无 PG 写，首次归属/恢复定位另计 |
| 完整 assistant + usage + sampling 完成 | 一条组合 native Fact | 一个 PG 投影事务；然后淘汰已覆盖 tail |
| 校验后的 Tool intent | native intent Fact | native 投影及 Tool 开始展示 |
| 具体 Tool command | 独立 command Fact | 路由到 owner Broker，不等待 guest 完成 |
| Tool result | Worker 处理后 native Fact | 保存上下文结果；发送小型结果退休通知给 Broker |
| 终态 seal | PG Outbox relay append | 原子提交终态、未完成前缀、恢复进度及下一 Run readiness |

这里的 Kafka append 是语义记录数，不等于网络请求数；Producer 会对运输批次合并。
模型输出、合法 intent、具体执行命令也不是同一份内容的三个完全相同备份。

### C/B：完整信息的 PG 投影仍有写放大和 SQL 放大

[projectNativeSessionAppend](../packages/pi-session-postgres/src/project-native-session-append.ts#L88)
把完整 Entry payload 写入 `pi_session_entries`，同时把含该 Entry 的 payload 写入 `pi_session_log`；
Record 同样写入 records 和 log。原生日志是权威，另外两张表是查询投影，不是两个可独立修改的权威。
但投影确实不是纯指针或轻量索引：完整内容有物理重复。

对于非重放、已有 Lane、无 label/fact/新 Lane 的“assistant Entry + usage/completion Records”批次，
逐语句静态计数为 **13 条业务 SQL + BEGIN/COMMIT**：外层 Run/Writer 锁 2；Session/幂等/Lane/ID 检查 4；
entries/records/log 插入 3；Lane/Session 更新 2；Run 覆盖及 partition 进度更新 2。
这是特定 native 投影分支的源码计数，不是本次新测的网络耗时，也不包含首次 publication 查询。
见 [外层投影](../packages/runtime-core/src/postgres-pi-session-append-projector.ts#L14)。

建议先合并同一事务、固定 Session 下的检查/批量更新，并测量投影落后量。
进一步将查询表 payload 改成日志引用可以评估，但它改变物理持久化设计，必须单独讨论、做真实数据量实验。
JSONB 压缩、TOAST 和索引使实际磁盘倍数不能仅凭“两份字段”推算为严格两倍。

### C：一个投影组换来的控制面耦合

Projector 同一分区按顺序等待 Tool 路由、Subagent 控制交付的确认。
[ToolCommandRouter](../packages/tool-broker/src/tool-command-router.ts#L84)
对活着但暂时不可达的 owner 会重试，其他同分区会话因此被挡住；其他分区仍可继续。
这不是“所有 Session 全局串行”，也不是等待 Bash 执行结束。

有序交付保障了统一封口边界，但跨租户共用分区时会扩大故障影响范围。
应该先测 owner 延迟注入下的分区 p95 和阻塞时长；若要异步出队，必须引入可恢复的交付合同，
不能简单去掉 `await`。本轮不建议再加一套独立消费者/交付队列。

### D：保留 Kafka 与当前浏览器恢复合同

用户明确要求“可见先持久化、不把细碎 delta 写入 PG、浏览器无恢复游标”。Kafka 在这里有实际职责。
换回直接 HTTP/内存，必须说明未投影尾部在哪里持久化，而不是只画少一个箭头。
三 broker 同一宿主只提供进程层冗余，不证明主机故障 HA。

[SessionEventStream.open](../packages/runtime-core/src/session-event-stream.ts#L151)
先订阅，再捕获不可变 tail，再读 PG，以 coverage 合并；并非边读边删除用户正在看的数组。
大 snapshot 的分帧以及慢浏览器断开有价值。Browser 仍会承担大快照的解析内存，不能声称“恒定内存”。
正文分块 Markdown 已存在，不宜又设计一套重复渲染管线。

## 3. Worker、Pi Runtime 和 Subagent

### 调用层与真正的进程边界

```text
PostgresPiWorker → RunExecutor → AgentRunExecutionBackend → AgentRunSupervisor
    → RemoteToolSandboxTurnRunner → PiCloudTurnRunner → CloudAgentRuntime → Pi Agent
```

这是一个 Worker 进程内的调用层，不是八次网络 RPC。
分别包含队列、生命周期、通用执行适配、本地执行管理、远程工具绑定、Pi 配置/事件适配、
原生持久化 Harness 和 Pi loop。不是每层都无价值，但后台管理和 Pi 细节的依赖方向需要收敛。

### B：真实旧路径——WebSocket Steer

生产 [main.ts:229](../packages/control-plane/src/main.ts#L229) 创建 `HttpSupervisorSteerBackend`；
同时 [control-plane-runtime.ts:158](../packages/control-plane/src/control-plane-runtime.ts#L158)
仍创建 `WorkerControlChannelRouter`，gateway 还注册它。
进一步追踪发现 [TurnSteeringService:175](../packages/control-plane/src/turn-steering-service.ts#L175)
在未提供 backendFactory 时仍调用 `createRemoteSteerBackend()`，旧类继续实现 WS prepare/commit/release。
因此这不是“完全无调用者的死类”，而是默认生产不用、通用构造路径保留的旧 fallback。

建议明确支持的 Steer backend 注入合同，删旧 WS fallback/factory/backend/router 分支及只维护旧路径的测试，
保留生产 HTTP Steer 回归；没有 backend 时显式不可用，而非偷偷切换传输路径。
不要直接删共用的 command DTO 或 AgentRunSupervisor 本地生命周期 ACK：部分仍由进程内 backend 使用。
也不要删除整个 WS，它仍承担注册、心跳和租约续约。

| 通路 | 当前职责 | 建议 |
| --- | --- | --- |
| Worker → PG | 领取/恢复/所有权 | 保留 |
| Worker → Kafka | durable 输出与控制 Fact | 保留 |
| Worker ↔ CP WebSocket | 注册、心跳、续约；残留旧 Steer | 保留前者，清理后者 |
| CP → Worker HTTP | Steer、Subagent 管理、停止与退出确认 | 保留；不应仅按通道数量认定重复 |
| Worker 本地 Model Gateway | scoped provider 请求、取消、诊断、hosted search 适配 | 有价值，先修已复现竞态 |

### A：Model Gateway 的读请求体竞态

[model-gateway.ts:657](../packages/supervisor-host/src/model-gateway.ts#L657) 先检查 capability/请求次数，
随后 `await readBody()`，之后直接递增次数并发往上游；abort controller 也在读完 body 后才登记。
等待期间 `lease.release()` 已从 map 删除并标记 revoked，但 handler 仍持有旧对象并继续执行。

审查时的本机实验现已转入 [model-gateway.test.ts](../packages/supervisor-host/test/model-gateway.test.ts)
作为修复后的回归，旧缺陷复现脚本保留在 `365e8aa6` 的 Git 历史。运行当前回归：

```bash
npm test --workspace @pi-cloud/supervisor-host -- test/model-gateway.test.ts
```

| 交错 | 期望 | 实际 |
| --- | --- | --- |
| 收到部分请求体 → 撤销 lease → 补齐 body | 不再新发 provider 请求 | HTTP 200；假上游被调用 1 次 |
| limit=1；两条请求都通过前置检查，再补齐 body | 最多 1 次上游调用 | 两条均 200；上游调用 2 次 |

不需要恶意第三方或真实账号才能重现；实验只使用临时 loopback 服务和注入的假 fetch。
这证明了内部请求撤销/计数的缺口，不证明生产已经发生此问题，也不意味着 Kafka 封口失效或数据串租户。
正常 Pi 的单次采样路径通常串行，因此并发计数场景有明确触发条件。

根本修法：读 body 的阶段也纳入可撤销 in-flight 生命周期；真正转发前在无 await 的同步区间
再次确认 capability 仍是当前有效对象，并完成请求计数判断/递增。不需要再查 PG、不需要新令牌体系或重试层。

### B：Worker 适配层与存储包耦合

`CloudAgentRuntime` 位于 `pi-session-postgres`，但它负责模型 loop、工具中断、Compaction 和上下文注入，
不仅是 PG 存储。建议把运行合同/实现移到已有 Runner 侧，让 PG 包只保留 Repo/Storage/Projection。
先移动依赖方向而非重写 Agent；不建议再造一个新“大核心包”。

`runtime-core` 的 `agent-run-execution-backend.ts` 运行时 import 具体 sandbox-supervisor，
Control Plane 因此把 Pi Runner、fake-model-server 也带进 Docker 依赖闭包。
队列生命周期应依赖执行端口，具体 Pi backend 放 Worker 侧。当前 package 图没有生产环，问题是职责越界，
不是“发现循环依赖”。详见 [inventory](inventory.md)。

`RemoteToolSandboxTurnRunner` 的生产依赖和控制分支里还有 `FakeModelServer`；
抽到测试工厂或既有测试注入点，不删测试能力，也不把真实请求失败降级到 fake。

### D/C：不是把原生 Pi 换回 JSONL 就能删除这些职责

已检查安装的 0.84.1：`AgentHarness.prompt/compact/resume` 仍是未完成接口；
PiCloud 使用公开 Agent、SessionRepo/Storage、Compaction 原语补上云端合同，有现实原因。
多 Lane 共享日志与不同上下文模式是独立维度，不能简化成“每个 subagent 一个独立进程”。
编排脚本仍在 Cube；`runs.*` 经 Worker 发布日志，再由 Projector 控制面准入，Worker 开启 Lane。
这段绕路是明确选择统一顺序的成本，并不是误把编排脚本放在可信 Worker 执行。

Boot ledger 的身份/退出证明影响旧 Worker 恢复判断，不是纯粹 LAN 鉴权。
若要用 Kubernetes Pod UID/退出状态替代，应先决定 Compose 裸进程如何提供等价证明。

## 4. Tool Broker 与 Cube

### 一次已热启动的 Bash

```text
Pi 完整输出/合法 intent 持久化
→ Worker 发布具体 command 到 Kafka
→ Projector → owning Broker HTTP
→ Broker 操作准入事务 → Cube envd 写请求文件 → envd 启动一次性 helper
→ guest 执行 → Broker 结算/结果缓存
→ Worker 等待的 GET 收到结果 → Pi 处理 → native result 写 Kafka
→ Projector 通知 Broker 退休原始结果
```

Worker 的结果 GET 通常是等待一个 operation Promise，不是反复轮询。重连只读取同一结果，不重新执行命令。
冷启动另加 binding/Volume/VM 创建与环境验证，不能用热路径数字代表首次 Tool。

`beginOperation` 静态计数：5 条 SQL + BEGIN/COMMIT（runtime 锁、owner 检查、authority、去重、INSERT），
成功 `settleOperation`：2 条 SQL + BEGIN/COMMIT；合计 **11 次**，不含路由缓存 miss、binding 与冷启动。
这不是新测出的耗时。可研究把去重 SELECT 合并为条件插入，但不能改成“冲突后重跑 Shell”。

### C：一次性 helper 的代价

[guestJson](../packages/tool-broker/src/cubesandbox-sandbox-provider.ts#L727)
每次工具先写 JSON 文件，再通过 envd 启动 Node helper，最后清理请求文件。
所以即使一个小 `read`，也不只是一次内存函数调用。它换来没有常驻自制 guest 控制器、guest 无平台凭据。
可测量 read/write 在直接 envd API 与一次性 helper 间的差别，但不能为了省进程启动，又偷偷加回常驻控制器。

### B：巨型类的职责应按资源寿命拆，不是按任意行数拆

ToolBroker 2798 行、状态仓库 2282 行、Cube provider 2247 行，混有 task binding、弹性 VM、独享 VM、
terminal、preview、warm eviction、配额/容量、owner recovery 等不同寿命的状态。
优先在现有服务内部拆为绑定/操作、弹性环境、独享机器、交互入口几组；共用 authority 与 Cube adapter。
不增加四个微服务，也不在“拆分类”时复制四份状态。

### D：Volume Gateway 不是 Cube API 的简单重复

它还承担 PiCloud 的租户/Workspace 身份、live 文件浏览、Git 凭据写入、删除授权及 POSIX 路径访问；
Cube 的 Volume API 不知道哪个员工有权看哪份 Workspace。
不能仅因 Cube 有 volume/delete 就认为这层全部可以删。
相反，已经移除的文件快照权威、runtime_objects、平台 Git 管理不应重新加回来。

工具效果登记、UNKNOWN、結果退休缓存并不因为部署在内网而无用。
当前缓存有字节/活跃命令边界，封口/绑定退休会释放结果；不应把“有内存中转”直接等同于泄漏。
已执行命令的副作用不被封口撤销，Cube 最终执行入口的原子代次隔离仍是明确未完成边界。

## 5. API、数据库与前端

### B：确定的遗留候选与不能误删的表

| 对象 | 当前实际使用 | 判断 |
| --- | --- | --- |
| environment_operations | 应用源码无读写，只有类型/迁移 | 优先清理候选 |
| usage_ledger | 应用源码无读写；native usage 已写会话日志 | 历史计费候选 |
| model_requests | 无正常 INSERT，只在故障回收 UPDATE reserved | 孤立清理路径 |
| model_rates | bootstrap/模型配置时 INSERT，未找到生产消费 | 有写无用的维护成本 |
| dailyTokenBudget / maximumCostMicrousd / monthlyCostMicrousdBudget | 领取读取、wire 传递，未找到执行端额度判定 | 不应让这些字段暗示已实现计费约束 |
| workspace_operations | 当前保存会话 archive/unarchive 的幂等记录 | 活功能、错名字，不是死表 |
| pi_session_entry_refs | Human Fork 仍写 COW 查询引用，同时写完整目的日志 | 活路径，不能作为旧兼容直接删除 |
| active_execution_scopes / pi_session_visible_entries | 普通 SQL View | 不是两份独立状态表 |

“预留计费能力”可以保留 Pi-native usage 与将来的投影接口，不必保留无人消费的价格写入、
required wire 预算和无法产生新记录的旧回收路径。正式删除前需处理旧数据/FK，不是删类型就完成。

### B：命名残留与重复字段

- `sandboxes`/`sandboxId` 在 Worker 注册路径指可信 Worker，而 Cube VM 在另一套表中；容易误解隔离位置。
- ToolCommandExecutor 的 `callKey()` 两次加入同一个 runId，私有 map 仍叫 `attemptWriters`。
- Model Gateway tracing 仍写 `pi_cloud.attempt.id = runId`；Broker 仍有 `attempt_context_mismatch` 错误码。
- 这些是职责/命名债，不等于仍有独立 RunAttempt。Pi 的采样重试 attempt 仍有实际意义。

### C：NestJS 不是额外一跳网关

[application.ts](../packages/control-plane/src/application.ts#L50) 在同一个 Fastify 实例安装
ProductionHttpGateway 和 Nest。前者是认证/health hook，不是第二个代理进程。
Nest 的 providers 大量手工 useValue，确实可讨论是否值得保留框架；但重写 51 个 controller 路由
不应排在真实遗留清理之前，也没有证据表明它是当前毫秒级延迟主因。

### C/D：产品功能不是“附带包袱”

`sessions` 是产品会话视图/环境绑定/模型选择，`pi_sessions` 是物理日志和 epoch，
`pi_session_lanes` 是分支 head，`subagent_executions` 是委派任务生命周期。
它们不是四个可互相替换的 messages[] 存储。可以改进名字和字段归属，但合表必须先明确
普通 Fork 与只读 Child View 的不同生命周期，不能用“表名都像 Session”作为删除理由。

Fork、导航、目录选择、开发机、SSH、Preview、GitLab Issue 都是用户明确要过的功能。
可收敛模块边界和安装入口，不能因为“最小聊天”不需要就直接删。
多租户可以对应内部员工/团队，不是只有公有 SaaS 才需要隔离会话和凭据。

前端入口盘点及渲染关键路径已检查，未做本轮全按钮浏览器验收。
ChatApp.tsx 为 2301 行，建议按 Session 数据流、资源选择、侧栏/导航切开，保持一个清晰的当前会话身份。
已有稳定 Markdown 分块和 snapshot/reconnect 合同；不应重复引入另一个全局状态真源。

## 6. 部署、脚本、测试与文档

### 修正数量口径

基线有 20 个 package、146 个编号迁移、50 份编号 ADR。TS/TSX source 97850 行，
其中包含 11400 行迁移；175 个测试文件 48600 行；87 个 scripts 文件 26190 行。
详见 [结构盘点](inventory.md)。数量本身不能证明过度设计，但足以要求严格区分核心/可选职责。

Compose 基文件 24 个服务定义，Cube overlay 增加两个；当前默认配置解析出 19 个 service，
包含两个 Worker 和三个一次性初始化项，约 16 个常驻服务定义；Cube/K3s 的控制面/计算面另外计算。
监控六项是 optional profile，image-only 也不是常驻服务。不能说“32 个定义全部必须同时启动”。

| 组 | 必要性/取舍 |
| --- | --- |
| PG、Worker、API/Projector、Web、Tool Broker、Cube/Volume | 当前产品核心 |
| Kafka 三 broker | 当前 durable/replay 合同；单宿主不是跨机 HA |
| CLIProxyAPI | 当前多 provider/订阅入口，避免 PiCloud 自造账号池 |
| Provider/Cube relay | 当前 Compose 网络/宿主代理适配；可评估部署条件化，不该当作 Agent 语义 |
| SSH | 用户选择的产品能力，是否默认启动可讨论 |
| Prometheus/Grafana/Jaeger/Alertmanager | 已 optional，不应再声称被强制部署 |
| bootstrap | 安装步骤，不是新的长期调度服务 |

### B/C：测试成本比“测试太多”更值得修

CI 的 `npm run ci` 先跑全量测试，然后 `run-fault-eval.mjs` 又逐条启动 Vitest 执行 manifest 中的同一批用例。
每条故障都重复变换/加载模块，部分重复建库迁移。可按文件分组一次执行，再把结果映射回 fault ID，
保留“目标不存在/跳过不算通过”的验证。无需删除真实的故障覆盖。

146 次历史迁移在许多全新测试库反复执行。预建测试模板库可减耗，另留一个从空库跑完整迁移的检查。
生产 baseline squash 需要显式选择旧部署升级/重置策略，不能作为本轮普通清理顺手做掉。

原 CI 每次 push/PR 还构建和扫描 9 个镜像，值得按改动路径/依赖闭包规划重用。
秘密扫描、外部边界检查不因内网部署就无意义；问题是重复启动和重复工作，不是验证本身。

### C：依赖硬化应作为暂时补丁而非永久架构

[harden-pi-dependencies.mjs](../scripts/harden-pi-dependencies.mjs) 确实修改 node_modules：
固定版本替换若干传递依赖，并对 json-ext 做限定源码的一行修正。不是私自改 Pi agent loop。
它已有版本/原文检查，比无条件 sed 安全；但 lockfile 本身不完整描述最终运行目录。
应保留明确的补丁范围、上游退出条件，优先在上游修复或兼容升级后删除。不能为了变短恢复已知缺陷。

### B：全量发布把整个仓库 Git revision 与 guest 模板过度绑定

`production:deploy` 每次都调用模板注册，而注册脚本用整仓 HEAD 作为 imageRevision；
复用条件要求 previous imageRevision 等于该 HEAD。即使改动只有文档/前端，全量发布也可能重建 guest 模板。
建议使用 guest 构建输入的指纹/明确 runtime release 版本，加上独立的 guest 协议兼容检查。
它可以降低模板 churn，但需要新的发布验收合同，不能简单取消版本检查。
不要夸大为“每次普通 up 都必须重建”：Compose wrapper 在未显式覆盖版本时可以沿用已登记模板版本。

### B：文档需要分清“合同”和“考古”

README 目前已经短，不应再塞回几十个细节。ARCHITECTURE/ADR 负责当前合同，
版本化验收报告负责历史证据。50 个 ADR 不等于 50 个仍独立运行的子系统。
过多“不要恢复旧方案”的措辞说明历史方案曾混入当前理解，但解决方法是删除死路径、明确 owner，
不是继续追加更多反向禁令。此审查目录不是新的实现规格，未批准的建议不能当作当前架构。

## 建议施工顺序与边界

1. 修 Model Gateway 两个已复现交错；补精确回归，不扩大到新鉴权体系。
2. 移除生产未使用的 WS Steer 分支；保留 HTTP Steer、WS 心跳与退出证明。
3. 清理计费遗留和无调用表；保留 native usage。修正错误命名和重复字段。
4. 调整 package 依赖方向、测试 fake 注入；不重写 Pi loop，不新增微服务。
5. 分离普通环境读取/版本更新，合并安全的 SQL；分别测受理、领取、投影、结算，而非只追“18”。
6. 对大 payload 双份存储、控制面/投影服务分离、boot authority 替换、迁移 squash 单独讨论。

第一批适合局部修复/清理；第六项改变数据或服务合同，必须获得架构选择后再实施。
把 Kafka Tool/control 改回直接 RPC、删除 seal、改回共享 JSONL 均不在本报告的默认建议中。

## 本轮实际验证与未覆盖

- 两个 Model Gateway 交错已在隔离临时 HTTP 服务复现，假上游、无生产凭据、无付费 Token。
- 定向现有测试：Model Gateway 10、Kafka consumer lifecycle 5、Tool executor 13、publication 3、live view 1，
  共 **32 项通过**。既有测试通过与新竞态复现并不矛盾：它们未覆盖读 body 中途撤销/并发占用的交错。
- 只读核对生产 schema；检查 package 图、controller 路由、Compose 服务、核心数据流、上述具体调用者。
- 没有重跑此前 1111 项全量测试、真实模型/Cube、全按钮 UI、企业并发或磁盘容量基准。
- 不宣称看过全仓每一行；源码关键路径审查与全文件检索盘点不是同一件事。
- 未修改生产配置、数据、服务实例和业务实现；下一阶段修复需要单独验收。
