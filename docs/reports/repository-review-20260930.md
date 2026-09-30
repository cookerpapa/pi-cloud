# 全仓审查 · 2026-09-30

这是修复前的基线报告；实施结果见[10 月 1 日修复记录](repository-review-repair-20261001.md)。

审查基线：`5fd6159f8a0ec0cc5d4ebc0dc24071c29b82028d`；Pi 三个包均为 **0.84.1**。
开始时工作区干净。审查没有修改业务实现、升级依赖、迁移生产数据或重新部署服务。
新增内容仅为报告、复现脚本和待办记录。

结论：现有的 Pi Agent Loop、Worker 外层运行时、单 Session writer、Kafka、统一
Projector、PG 原生日志和 Cube 执行边界应继续保留。本次没有找到足以推翻这套架构的证据；
需要修复的是边界上的不一致，以及全量验证与近期改动脱节的问题。
确认 **8 项问题**，另有 **3 项需要讨论的语义/故障边界**和若干精简机会。
“审查完成”不表示发布检查通过：当前全量检查和依赖安全检查均有失败。

## 范围、方法和证据

基线共有 **1,220 个受版本控制的文件、21 个 package**。分类为：324 个非迁移源码文件
（323 个 TS/JS 模块和 1 个 CSS 文件）、155 个迁移、244 个测试及 fixture、105 个文档、
185 个历史证据文件、98 个脚本、44 个部署文件、65 个配置文件。

采用全仓清单/依赖扫描、关键调用链语义审查、当前 ADR 与历史决策核对、原生 Pi 源码比较、
自动化测试和定向故障复现。323 个 TS/JS 模块均经过结构/引用扫描；核心持久化、执行、
恢复和权限边界作了更深入的调用链核对。**这不等同于逐行证明全部源码正确**，也不是
独立渗透测试。历史迁移经过当前完整迁移链验证，但没有把旧 Cell/Temporal/affinity
设计当成现行拓扑。历史报告按证据归档审视，没有重新执行其中所有旧实验。

| 覆盖面 | 本次重点 |
| --- | --- |
| sandbox-supervisor、supervisor-host | Pi Loop、原生 hooks、采样/重试、Tool intent、Steer、Step 环境、物理 Session 容量、模型 permit |
| runtime-core、event-log | PG admission、lease/epoch、Run 终态、Kafka ACK、dispatch commit、Projector、回复匹配、链路探针 |
| pi-session-postgres、database | 单 writer、准确原生日志、seal、最新 Compaction 与活动后缀、冷读、Fork、完整迁移链 |
| control-plane、subagent-control | 多租户查询、队列编辑/取消/Steer、配额、归档、Workspace 重绑、子 Lane、GitLab/GitHub 边界 |
| tool-broker、tool-sandbox、workspace-runtime | 独立执行授权、Cube 生命周期、原生完整 Tool、取消/UNKNOWN、Volume、上传、终端/预览 |
| session-attachments | 图片 claim check、重复上传去重、冷恢复、租户/对象绑定、引用与清理 |
| cube-api-authorizer、cube-egress-gateway、provider-egress-relay、ssh-gateway | 出站授权、DNS/地址限制、代理失败、凭据边界、SSH 错误处理 |
| protocol、domain | Cloud-owned 公共协议、大小预算、终态定义、Pi 事件边界、失效抽象 |
| web-ui | 快照/SSE、pending input、Steer 重试身份、附件、Workspace 选择、运行状态、浏览器生命周期 |
| observability、fake-model-server、脚本/部署/配置 | 测试夹具、告警/监控配置、镜像依赖、Helm/preflight、安装器合同、安全依赖 |

回看了 `~/` 下原长会话中关于两个提交边界、统一 Projector、Session 容量、
commit-before-dispatch 和审批延期的相关讨论。当前 ADR 是架构判断依据；没有把会话正文、
凭据或用户仓库内容复制入 Git。

证据入口：

- [全仓清单与检查层次](repository-review-20260930-coverage.json)
- [验证汇总、版本、日志摘要与哈希](repository-review-20260930-verification.json)
- [四组定向复现结果](repository-review-20260930-probes.json)
- [104 项故障矩阵原始结果](repository-review-20260930-faults.json)

## 确认的问题

这里的 P1 表示应优先消除的发布阻断，P2 表示有明确触发条件和证据的实现/验证缺陷。
依赖通告的 high 严重度与 PiCloud 的实际可利用性分开表述。

### R30-01 · P2 · Tool 回复等待失败绕过了停止后续采样的保护

位置：[trusted-remote-tools.ts](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts)
第 328、479 行；[remote-tool-sandbox-turn-runner.ts](../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts)
第 632、647 行。

收到 Broker 返回的 `cubesandbox_tool_result_unknown` 时，适配器会调用
`onToolOperationUnavailable`，外层运行时记录失败，阻止下一次模型请求。
但回复 Promise 因等待超时等原因直接 reject 时，较早的 catch 只抛出
`tool_operation_outcome_unknown`，没有设置同一个失败状态。Pi 将工具异常转换为
Tool error 后，可以继续调用模型。

使用实际 Pi、CloudAgentRuntime 和远端 Tool 适配器，接入与生产相同的采样失败检查，
得到以下对照；模型、回复和 publication 均为夹具，没有执行 shell：

| 路径 | 模型请求次数 | unavailable 回调次数 | Run 结果 |
| --- | ---: | ---: | --- |
| Broker 返回明确 UNKNOWN 错误事件 | 1 | 1 | failed |
| 回复等待直接 reject | 2 | 0 | completed |

例如 Bash 已发出，Worker 等不到回执，接下来仍可能请求模型决定后续工具。这并不证明
模型一定重复执行命令，但违背当前“基础设施不可用后停止本轮”的约定。
建议把传输拒绝也归入现有不可用处理，保留 UNKNOWN 和原始 cause；取消仍按取消处理。
验收应覆盖超时、回复消费者关闭、错误身份/解码失败，并证明没有第二次采样或自动 Tool 重放。

### R30-02 · P2 · 消息归一化损坏 JSON 自身属性，导致整轮失败

位置：[cloud-agent-runtime.ts](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts)
第 174–180 行。`normalizeMessage()` 创建普通 `{}` 后使用 `result[key] = ...` 递归复制。

`JSON.parse('{"__proto__":{"marker":"must-survive"},"regular":1}')` 是有自身
`__proto__` 字段的合法 JSON。复制时这个字段变成了新对象的原型，Pi 的持久化检查随即
拒绝这个非普通对象。Tool details 对照夹具的实际结果为
`model_error: Durable payload contains a non-plain object`，没有写入 Tool final result；
直接使用原生 Pi Session append 则保留该字段。

另用实际远程 Bash Tool 配置复现：模型产生包含同名额外属性的 Tool call 参数时，
整轮在保存 Assistant 时就失败，尚未发布任何 Tool 命令。工具参数是否符合 schema
本应由后续原生验证处理，JSON 复制不应提前损坏消息。
当前 Subagent workflow 返回已文本化，因此不把任意 workflow 返回直接进入 details
当作生产触发路径。这里证明的是数据保真/可用性问题，**没有证明全局原型污染或代码执行**。
建议使用保持自身属性的复制方式，继续过滤 undefined，不必删除整层归一化。
验收需覆盖嵌套对象、数组及特殊字段，确保与原生 Pi 的 JSON 保存结果一致。

### R30-03 · P2 · Subagent 输入预算在接收、原生日志和公共视图间不一致

位置：[subagent-tool.ts](../../packages/sandbox-supervisor/src/subagent-tool.ts)、
[postgres-subagent-job-provider.ts](../../packages/subagent-control/src/postgres-subagent-job-provider.ts)
第 239 行、[cloud-agent-runtime.ts](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts)
第 362 行、[control-plane-api.ts](../../packages/protocol/src/control-plane-api.ts)第 796 行。

Subagent Tool 参数没有 task 长度上限，JobProvider 和 Worker 输入协议允许 1,000,000
字符。启动时原生操作记录的 `originalPrompt`、`initialMessages` 和 user Entry 各包含
一份输入。实际运行时产生的启动操作，200,000 个 ASCII 字符为 **600,669 字节**；
400,000 字符为 **1,200,669 字节**，已经超过 **921,600 字节**的 ExecutionFact 上限，
尚未加入外层封装。参数验证却均通过。

另一个较小边界是公共 Turn 的 prompt 只有 100,000 字符。PG 复现接受了 200,000
字符的子任务；把持久化的 prompt 放入实际公共响应 parser 的活动 Turn 形状后被拒绝。
这里的活动状态是夹具，没有实际运行该子 Agent；ConversationReader 对 prompt 直接透传，
Web 使用同一个 parser。

因此失败可能发生在子任务已接收之后，或在读取它的页面时。建议按最终编码字节预算统一
入口、Worker、原生日志和公共视图合同，给出早期、明确的拒绝。不要删掉 Pi 原生恢复字段，
也不要单纯放大 Kafka 消息。验收要覆盖中文/转义字符及封装开销，不能只测试字符数量。

### R30-04 · P2 · 长会话的 Subagent 继承历史查询不受 Compaction 约束

位置：[conversation-reader.ts](../../packages/control-plane/src/conversation-reader.ts)
第 456–507 行。

`#delegatedInheritedMessages()` 沿 Entry 祖先一直递归，跳过 Compaction 本身，查询所有
历史 message；超过 10,000 条就让整个子会话详情失败。模型冷恢复已经只需要最新压缩与
活动后缀，但这个查询仍与会话终身历史长度有关。

隔离 PG 使用当前完整迁移和真实服务方法复现：

- 10 条旧消息之后放一个 `retainedTail: []` 的 Compaction，子会话仍返回这 10 条旧消息。
- 10,001 条旧消息之后放同样的 Compaction，详情报 `invalid_request: Inherited conversation is too large`。

大量历史在夹具中直接投影到 PG，并非声称单个 Kafka 消息携带了这些条目。
普通用户 Fork 的分页有界，这个问题限定在 Subagent inheritedMessages 路径。
建议按继承上下文定义读取 Compaction/后缀，或者独立分页展示历史，避免历史附件阻断整个详情。
若改变 UI 展示完整历史还是模型实际上下文，需要明确协议；两种选择都应有界。

### R30-05 · P2 · 子任务 timed_out 终态漏掉 seal 等待

位置：[postgres-subagent-job-provider.ts](../../packages/subagent-control/src/postgres-subagent-job-provider.ts)
第 842 行；[run-executor.ts](../../packages/runtime-core/src/run-executor.ts)第 1139 行。

`status()` 在子 Run 仍未 seal 时，把 completed/failed/cancelled 暂时映射为 running，
但列表遗漏 timed_out。后者是 RunExecutor 实际写入的状态，不是一个不可达枚举。

最小隔离 PG 行夹具直接运行生产 `status()` SQL：lease 存在且 `output_sealed_at` 为空时，
前三种状态都返回 running，timed_out 却立即返回 failed。父 Agent 因而可能先看到终态，
而子 Lane 的日志收口仍未完成。没有由此推断 shell 会重放。
建议复用完整 Run 终态判定，补齐各终态 seal 前后的对照测试；不增加新的确认机制。

### R30-06 · P2 · HTTP 出站代理没有传递上游响应中断

位置：[proxy-server.ts](../../packages/cube-egress-gateway/src/proxy-server.ts)第 193–208 行。

HTTP 路径处理了 ClientRequest error，却直接 `upstreamResponse.pipe(response)`，
没有处理响应流的中途 abort/error。localhost 上游夹具声明 Content-Length 10000，
写入少量内容，25ms 后断开：网关进程仍存活，但下游等待 **11 秒**后仍未结束或报错，
超过设置的 10 秒上游请求超时。已经关闭的上游连接不会靠这个超时替下游收尾。

用户通过 HTTP 下载可能一直占着 Tool/连接，直到调用方自己的期限结束。
该复现没有访问外网；也没有发现整个网关崩溃。HTTPS CONNECT 已有双向关闭处理。
建议补齐 HTTP 响应流和客户端断开时的双向销毁，保留限流与出站策略。

### R30-07 · P2 · 全量检查仍包含旧版 direct Steer 的组合测试

位置：[control-plane-runtime.test.ts](../../packages/control-plane/test/control-plane-runtime.test.ts)
第 160、190 行。

全量 `npm run check` 中唯一失败的测试仍手动插入旧 `kind: steer`、旧 fingerprint/payload，
对未正确进入运行态的目标请求 Steer，并断言 HTTP 200 与同步 transport 调用。
[ADR-0203](../adr/0203-consumption-confirmed-direct-steer.md)现行合同是持久化来源输入、
HTTP 202 和 reconciler 投递；本次实际得到 HTTP 409。

这是上一轮实现遗漏的组合测试迁移。之前相关 437 个测试及真实验收通过，不能替代本轮的
全仓检查，也不能据此声称生产远程投递已经损坏。
应按真实运行中目标构造 fixture，验证 accepted source、驱动 reconciler 和注入的远程
transport；不能只把期望状态码改成 202，更不应恢复旧兼容分支。

### R30-08 · P1 · 当前依赖安全发布检查失败

位置：[package.json](../../package.json)的依赖硬化版本、
[control-plane/package.json](../../packages/control-plane/package.json)及相关锁文件。

`dependencies:check` 通过只证明已安装版本符合仓库现有的替换规则；
`security:audit` 现在失败。审计返回的剩余包为 brace-expansion、undici（high），
fast-uri、vitest、@vitest/mocker（moderate）。这是 **5 个包条目，不是 5 个独立漏洞**。
原始 npm 合计另包含一个由既有 shrinkwrap 硬化规则处理的 Pi 父包聚合条目。

实际版本包含 brace-expansion 5.0.9、undici 8.10.0/6.28.0。
维护者通告确认这些版本分别落在嵌套递归 DoS 和 WebSocket 异常的受影响区间；
相关补丁包括 brace-expansion 5.0.11、undici 8.10.2/6.28.1。
另一个 brace-expansion 二次复杂度问题需要 5.0.12，不能只针对一条通告选版本。
见 [brace 递归通告](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-qhr7-859c-m2p7)、
[brace 复杂度通告](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr)、
[undici 通告](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5)。

本轮没有证明这些问题可经 PiCloud 公共端点利用。当前 GPT 路由固定 SSE、管理连接使用
`ws`，也未发现应用调用相关 BalancedPool/cache interceptor；用户扩展自动加载禁用。
这些限制应计入可达性分析，却不能继续把安全发布检查记为通过。
建议独立修补依赖并跑 Pi/HTTP 合同测试，保留 Pi 0.84.1；不要按 npm 的聚合建议盲升 Pi
大版本，也不要新增忽略项来让门禁变绿。

## 需要讨论的三项边界

### D30-01 · 同一 Workspace 的弹性 Cube，取消故障域与共享计算的关系

[ToolBroker](../../packages/tool-broker/src/tool-broker.ts)第 2118 行在取消一个 binding 时，
本来会保留还有其他 binding/terminal 的 VM。但
[CubeSandboxProvider](../../packages/tool-broker/src/cubesandbox-sandbox-provider.ts)
第 1147 行会在单次非持久 Tool 传输失败/abort 时销毁整个弹性 VM。
组合起来，一个正在执行的 Tool 被取消，可能影响同 Workspace 的其他 Session 或终端。

这是代码路径证据，本轮没有破坏真实共用 Cube 来重演。
[ADR-0151](../adr/0151-development-machine-failure-boundaries.md)明确保留弹性环境的
fail-closed 清理，持久开发机则不得因单 Tool 失败被销毁。因此不能把 destroy 直接删掉。
需要决定是否接受 Workspace 级计算故障域，或在 Cube 能确认进程作用域取消/执行代次后缩小它。
PG 的 Session/Lane lease 隔离并不等于共享 VM 的故障隔离。

### D30-02 · 配额按历史总量还是当前活动资源计数

[ControlPlaneStore](../../packages/control-plane/src/control-plane-store.ts)创建 Session 的配额
统计包含 archived 行，Subagent 也会创建逻辑 Session。公开删除操作归档会话，保留日志资产。
真实 PG 复现将 maximumSessions 设为 1：创建后归档，界面可见数为 0，再创建仍报
`tenant_quota_exceeded`。

目前是可解释的历史总量口径，但用户容易以为删除释放了可用会话数。
建议区分活动资源配额和保留历史预算，并明确子任务计费/配额单位。不能为了释放配额物理删除
原生日志。本轮只复现 Session；没有把其他资源的类似 SQL 推断当成已复现的问题。

### D30-03 · 失败前可见文本是否进入下一轮模型上下文

CloudAgentRuntime 保存 error/aborted Assistant 原文和通用中断提示；Pi 0.84.1 的
`pi-ai/dist/api/transform-messages.js` 第 159 行按原生规则删除失败/中止的 Assistant。
实际比较显示：成功文本在下一请求中可见，error/aborted 的文本在原始 Session 和 UI 中保留，
但在 provider transform 后消失。硬 Worker 丢失时，未覆盖的可见前缀则走现有恢复事实路径。

这并非 PG 丢失消息，也不是可以直接指责为“没有对齐 Pi”：过滤恰恰来自原生 Pi。
需要决定用户说“继续刚才没说完的内容”时，是否应把已展示文本作为标明不完整的事实保存到
下一轮上下文，从而让不同中断方式表现一致。即使选择保留，也不能重放残缺 Tool 参数或
冒充完整的成功 Assistant。该选择应先形成 ADR，再改恢复语义。

## SQL、耦合和精简机会

1. [Subagent result()](../../packages/subagent-control/src/postgres-subagent-job-provider.ts)
   完成路径有 status SELECT/UPDATE、Session binding SELECT、Run SELECT、final Entry
   SELECT 和 result_entry UPDATE，共 **6 条业务 SQL，另加 BEGIN/COMMIT**；status 的
   单 UPDATE 还单独开事务。这里是静态调用计数，没有把它写成实测延迟。可在保持 seal
   和租户条件的前提下合并稳定终态读取，避免无效更新。
2. [acceptTurnSteer()](../../packages/control-plane/src/control-plane-store.ts)事务接受输入后，
   再查询同一 control receipt。新建路径可从事务结果返回必要 ID，重放路径保留必要查询。
   这是单次 SELECT 的精简候选，没有理由去掉锁后重验、Broker 授权或 durable ACK。
3. `InMemoryWorkspaceRuntimeStateRepository` 仍在
   [生产源码及导出](../../packages/tool-broker/src/workspace-runtime-state-repository.ts)中，
   仓库引用只来自测试。可移动到测试辅助目录；PG 实现和 repository port 都要保留。
4. [Session 状态图](../../packages/domain/src/state-machines.ts)仍声明 cold→starting→idle，
   而 [Run admission](../../packages/runtime-core/src/run-executor.ts)已经原子地从 cold/idle
   进入 running。未发现当前 Session starting/evicting 的生产写入者。这是失效抽象/文档
   漂移候选，尚无对应运行事故；清理公共枚举或 schema 前需确认消费者并记录协议决策。

没有发现需要新增队列、缓存、调度器或第二套状态权威的理由。模块依赖仍可进一步收窄，
但问题集中在错误处理、终态和预算这些跨边界合同；用大规模重构包名不能替代修复它们。

## 对 Pi 对齐与现有设计的评价

正常路径保留原生 Agent 的工具验证、hooks、工具执行语义和模型消息转换；云化层负责租约、
远端 Tool transport、durable append、环境事实和恢复。完整 Pi Tool 在 Cube 执行，
Worker 没有因此获得执行项目代码的权限。图片使用不可变对象引用，Volume 仍是 Workspace
字节权威；lease、运行活动和链路健康也保持不同含义。

以下差异有明确当前设计依据，本轮没有把它们列为缺陷：

- 同一物理 Session 共用 writer/lease，子 Lane 保留任务身份与取消。
- 完整 Assistant 先落盘，参数校验后的 Tool intent 与命令一次发布；这两个语义边界不能
  因为都涉及 Kafka 就武断合并。
- Projector 先提交 dispatch 位置再执行；窗口内崩溃可能留下 UNKNOWN，但不会因投影重放
  自动重复任意 shell 效果。
- Subagent branch 锚点位于父任务当前 prompt 之前，来自 ADR-0144 的明确选择。
- 项目可执行扩展、自动 AGENTS.md 发现、用户审批界面、Agent Team 和独立本地运行器是
  既定产品范围/延期项，不应在 review 中悄悄变成承诺实现的功能。

没有确认预览 cookie 绕过、ModelGateway 的 `alg:none` 外形令牌鉴权绕过或 SSH 错误导致
进程崩溃：实际实现分别有 cookie 过滤/重复拒绝、随机令牌摘要校验和连接 error 处理。
图片 pack 对重复内容有 memoization，本轮也没有证实“同一图片多次重复上传”的推测。

## 验证结果与限制

| 检查 | 本轮结果 |
| --- | --- |
| `npm run build` | 通过；Vite 主 chunk 仍有 >500kB 提示，未做前端性能基准 |
| `npm run check` | 所有 workspace 类型检查通过；1,388 个测试通过、1 个失败、3 个 opt-in 跳过 |
| `test:acceptance-helpers` | 单独运行，52/52 通过；不能声称失败的 check 已运行到此阶段 |
| 完整故障矩阵 | 104/104，43 组；确定性故障注入，不是线上 chaos/HA 证明 |
| Web 两组浏览器检查 | 展示、队列编辑/排序/取消、direct Steer 重试、Workspace 重绑等通过 |
| Kafka 真实配置/ACK | 独立临时 Topic：有效 RF3 配置通过，6 种错误配置拒绝；测试消息 durable ACK；已确认 Topic 清理 |
| 依赖硬化、文档、运行预算、镜像 closure/context、监控 | 通过；不等于当前安全通告全通过 |
| Helm/distributed preflight、安装器合同/bash 语法 | 通过；不等于在干净主机/独立物理集群上部署验收 |
| `security:audit` | 失败，见 R30-08 |

PG 集成测试使用本轮专用 PostgreSQL，复现数据库逐个删除，容器在收尾时删除。
两个真实 Cube provider opt-in 本轮没有执行；默认跳过的 Kafka 项已由上表真实检查补充。
本轮没有新增付费模型请求，也没有重启生产 Worker/Projector。之前相同业务代码的 Luna/Cube
验收仍可参考 [direct Steer 记录](direct-steer-acceptance-20260930.md)，但不计入本轮测试。

## 复现方式与后续切片

以下仅用于复现历史基线。四个一次性 probe 已迁移为正确语义的回归测试，
并从当前工作树移除；需要复现旧问题时，在报告提交 `7c1f46ec` 的独立 checkout
安装并硬化其依赖，然后运行：

```bash
node --import tsx scripts/probe-review-native-boundaries-20260930.mjs
node --import tsx scripts/probe-review-egress-reset-20260930.mjs

# 先设置 PI_CLOUD_POSTGRES_INTEGRATION_URL，指向专用测试 PostgreSQL。
# 账号需有创建/删除数据库权限；不要指向应用数据库。
node --import tsx scripts/probe-review-storage-boundaries-20260930.mjs
node --import tsx scripts/probe-review-subagent-seal-20260930.mjs
```

每个脚本接受一个可选 JSON 输出路径。native/storage 脚本中的断言描述**基线观察到的行为**，
不能不加修改地纳入 CI 充当“正确行为”测试。修复时应转化为期望正确语义的回归测试，并用
原生对照证明没有引入兼容分支。seal 脚本用最小表结构隔离方法；storage 脚本才应用完整迁移。

建议按独立切片处理：先恢复全量验证和依赖发布门禁；再修 Tool 失败停止与 seal 终态；
随后修数据保真/大小预算、长历史查询和代理断流。三项讨论边界先定语义，SQL/失效代码精简
可放在相关修复中。每项都保留现有单 writer、UNKNOWN、防重复效果和会话资产合同。
