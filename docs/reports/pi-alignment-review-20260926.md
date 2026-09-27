# PiCloud 全仓审查：Pi 语义与云端职责边界

审查日期：2026-09-26。基线：`ad1aad5fba4aba2f61320283f374fc6ccf6688f5`。
本报告记录发现与建议，不改变当前架构合同，也不授权实施其中的建议。

后续：owner 已授权谨慎修复并暂停图片议题。
[修复与验证记录](pi-alignment-repair-20260926.md) 记录实际处理结果。
PI-06 重新归类为未承诺的资源加载功能；PI-12 保留其有意选择的低频并发保护。
以下代码定位和复现数据仍描述上述审查基线，不能当作修复后仍存在的问题清单。

## 范围与方法

基线有 1,016 个 tracked 文件、20 个 workspace package；脚本、实现、测试和历史迁移等
代码文件合计 173,809 行。数据库有 148 个编号迁移和一个迁移索引。
覆盖全部包的职责、依赖、入口和相关测试，并沿主要运行／恢复链路深入核查。
这是一轮全仓架构与代码审查，不是对每一行代码的形式化证明；生成文件、lockfile、
历史迁移和旧验收报告按依赖、迁移链和历史证据核查，不把旧拓扑视为当前实现。

对照基准是安装的 **Pi 0.84.1**，包括 Agent、agent-loop、SessionStorage、Record reducer、
Compaction、原生 Tools、NodeExecutionEnv 和 coding-agent 的资源加载。
`~/pi-latest` 的 **0.86.1 / c7cdb460aa8a0cebef3446c4166729b8a0d97ead** 仅作前向参考。
本轮没有把升级 Pi 或完整接入其高层 Harness 作为前提：0.84.1 的
`AgentHarness.prompt/compact/resume` 仍抛出未实现错误。

审查标准：原生推理／工具语义应由 Pi 掌握；PiCloud 负责授权、分布式归属、持久化确认、
执行环境与产品呈现。新增云端能力应有窄接口，不能靠复制原生状态机、扩大模块职责来拼接。

## 总体判断

当前分离方向成立：可信 Worker 运行 Pi Agent，Cube 执行完整工具，PG 决定 Run／租约，
Kafka 确认日志，Projector 统一投影，Volume 保存文件。此次没有发现需要推翻这条主线的证据。

主要问题集中在适配边界：**写入了形似原生但语义不同的 Record；把供应商 Tool ID 当成
更大作用域的调用身份；工具／日志的大小合同不一致；一些原生能力被包装层固定策略挡住。**
采样准备和展示转换还存在重复实现，使一次语义变化要在多个模块同步修补。

以下共 14 项。PI-02、PI-03 为 P1；其余为 P2。
P1 表示应优先排除的执行／可靠性问题；P2 包含确定的兼容性问题和有具体证据的设计改进项。
每项单独说明触发条件和验证强度，不能把“建议能力”解读为已有故障。

## PI-01 · P2 · 原生 Record 的 attempt 与 toolIndex 写法偏离 Pi 的语义

**已用当前 CloudAgentRuntime 和 pinned Pi reducer 复现。**

- [CloudAgentRuntime](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L369)
  每次请求模型都累加 `assistantAttempt`，写入 `step_attempt.attempt`。Pi 的 reducer
  将它解释为同一个未完成 Step 的重试序号；上一结果已完成后，新 Step 应从 1 开始。
  无重试的“模型→工具→模型”产生 `[1,2]`，上游 `validateRecordLog` 报
  `non_consecutive_attempt`。Compaction 在同一 operation 内累计 attempt 也应一并检查。
- [Tool intent 写入](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L1038)
  在真正进入 `execute` 时才 `toolIndex++`。若模型一批返回“未知工具、合法工具”，前者
  被 Pi 拒绝后不会进入包装器；后者的 native ordinal 被写成 0，实际应为 1。
  上游 reducer 报 `tool_call_mismatch`。

Pi 参考：`pi-agent-core/dist/harness/reducer.js` 的 `validateAttemptSequence` 和
`validateToolStart`。这里使用其源码中的 reducer 作为审查 oracle，并非声称它是已发布的
高层可用 Harness。现有云端恢复自己读取 Record，没有调用该 reducer，因此不能据此声称
当前所有多轮 Run 都会失败；问题是持久化语义不再能直接由原生 Pi 理解。

建议：区分 Cloud sampling identity 与 Pi Step attempt；以 assistant Entry 和原始
Tool ordinal 绑定 intent。补“正常多 Step、真正重试、前一调用校验失败、连续 Compaction”
的语义合同测试。保留已删除 RunAttempt 的决定，不把原生模型重试误改成 Run 重执行。

## PI-02 · P1 · Subagent 去重与展示关联缺少 Assistant／采样作用域

**本地确定性复现；没有声称已在真实供应商返回中观察到 ID 碰撞。**

范围澄清：普通 read/write/edit/bash 的远程请求在
[trusted-remote-tools](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts#L341)
生成随机 `operationId`，Kafka [reply mailbox](../../packages/event-log/src/tool-replies.ts#L88)
也按该 ID 寻找等待者。本项不是说这条回传通道用 `toolCallId` 作为唯一 key。
问题出在以下 Subagent 缓存和展示关联；它们没有使用这条远程请求的 operationId。
直接委派还可能完全不经过 Cube Tool 执行路径。

[TrustedToolRuntime](../../packages/supervisor-host/src/tools/trusted-tool-runtime.ts)
在整个 Run 生命周期内用 `[toolCallId, task.key]` 缓存子任务 Promise，并将
`workflowId` 直接设为 `toolCallId`。两个不同模型响应若复用同一个供应商 ID：

- 相同 task 第二次直接得到旧结果，没有创建第二个子任务；
- 不同 task 被拒绝为 `Workflow key reused with different task arguments`。

本地探针连续调用该真实适配器：两次相同任务只有一次 start；第三次不同任务报上述错误。
原生 Pi 的 Record 使用 `assistantEntryId + toolIndex` 区分调用，没有要求 Tool ID 在整轮
所有模型响应间全局唯一。

同一假设还出现在 [原生历史投影](../../packages/runtime-core/src/canonical-pi-conversation.ts#L197)、
[实时投影](../../packages/runtime-core/src/conversation-turn-projection.ts#L8)、
[前端 reducer](../../packages/web-ui/src/session-view.ts#L313) 和 Subagent 的调用结束检查中。
探针把两个 start/end 对交给真实实时投影，结果只有一个 Tool 条目，第一项被第二项覆盖。

建议：由可信 Runner 为每次原生调用提供稳定的 invocation identity，关联 assistant Entry／
ordinal，供应商 `toolCallId` 保持原样。Workflow 的内部 key 只在该 invocation 内去重；
展示关联与 Subagent 控制沿用相同身份。已有远程 `operationId` 解决的是具体远程请求关联，
不能自动修复此前已经发生的 Subagent 缓存和展示碰撞。公共事件调整需要先记录 ADR。

## PI-03 · P1 · 原生 payload 可超过执行日志的 Kafka 单条限制，并放大失败范围

**实际配置只读核验 + 本地真实工具返回大小复现；未向生产执行日志注入超限消息。**

生产 `pi-cloud.execution-log.v10` 的 `max.message.bytes` 为 **1,048,588**。
[Producer](../../packages/runtime-core/src/kafka-accepted-fact.ts#L203) 启动时校验 retention、
replica 等，但没有配置或核对这一上限；append 只限制全局 pending bytes／records。
Worker-boot reply Topic 则显式设置为 5 MiB。图片结果可以跨过回传通道后，仍在
Worker 写正式 native Entry 的下一条日志通道受阻；不能把两者都描述为 1 MiB 的回传限制。

同时：

- [工具请求](../../packages/protocol/src/tool-sandbox.ts#L320) 的 `tool.execute.args`
  不限制编码后总大小；1.5 MiB 写入请求通过 schema，编码后为 **1,573,480 字节**。
- [guest read](../../packages/tool-sandbox/src/native-tools.ts#L117) 可以返回 image content。
  探针生成合法 600×600 PNG，文件 **1,080,993 字节**，原生结果 JSON **1,441,440 字节**。
  文件未超过 2 MiB 读取限制，结果也未超过 5 MiB reply 限制，但它还必须成为正式 Session Entry。
- [stream error](../../packages/runtime-core/src/kafka-accepted-fact.ts#L192) 会关闭整个 bus
  的 producer lanes、拒绝全部 pending append；一个内容大小错误可波及共享该 bus 的其他 Run。

源头 Bash 裁剪解决不了 image、完整 assistant 参数和其他 native Entry 的编码大小。
SSE 的 begin/part/end 分片也不作用于此前的 Kafka 写入。

建议：建立从 Pi payload、guest、reply 到 native append 的统一编码大小合同；在入队前
隔离可判定的内容拒绝，别让单项过大变成 producer 全局故障。图片需要有界处理或明确的
能力拒绝。若采用 native append 分片，必须保持一条语义提交边界并先设计恢复合同；
不能静默截断原生消息，也不能直接新增第二个历史／对象存储权威。

## PI-04 · P2 · cwd 同时被当成文件权限根，破坏普通 Pi 文件语义

**原生 Pi／guest read／guest Bash 三方对照复现。**

[resolveToolWorkspacePath](../../packages/tool-sandbox/src/tool-worker.ts#L467) 将当前 cwd
作为访问根；[read 路径](../../packages/tool-sandbox/src/tool-worker.ts#L585) 又拒绝最终 symlink。
这套逻辑被完整原生工具复用后，选择子目录或 Git worktree 作为 cwd，会禁止文件工具读取
兄弟目录、父目录的项目说明、合法文件链接；同一个 guest Bash 仍能访问它们。

探针中 `read('../sibling.txt')` 和 `read('link.txt')`：原生 Pi 成功、Cloud read 报错、
Cloud Bash 成功；symlink 的目标就在同一个 cwd 内。

这是功能／策略不一致，不是跨租户逃逸证明。KVM 已是执行隔离边界，cwd 不应隐式承担
另一个未对 Bash 生效的权限边界。建议明确“执行 cwd”与“授权文件范围”，guest 内使用
适当的原生 ExecutionEnv 行为。宿主机上的 Volume Browser 仍需严格路径约束，不能与
guest 文件工具一起放宽。此项涉及既有路径策略，应先决定合同再实现。

## PI-05 · P2 · CloudAgentRuntime 没有保留 Pi 原生 Tool hooks 的接入缝隙

**设计扩展缺口，不是要求现在实现审批。**

Pi 0.84.1 的 Agent 已支持 `beforeToolCall`／`afterToolCall`。
[CloudAgentRuntimeOptions](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L74)
没有这些选项，[构造 Agent](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L425)
也不传递它们。现有 [remote-tool hook 测试](../../packages/sandbox-supervisor/test/trusted-remote-tools.test.ts#L105)
测试的是直接创建原生 Agent，绕过了生产 CloudAgentRuntime。

所以“Kafka 返回后由 Pi 运行 after hooks”在底层适配器成立，但生产装配没有可配置的
可信 hook 入口。后续做批准／拒绝、结果转换或可信策略时，容易再往远程工具包装器、Broker
或 Projector 加专项分支。

建议：只为代码拥有的可信策略提供原生 hook 接口，明确批准发生在 intent／实际执行之前，
after hook 后的结果才进入 canonical Entry。持久审批请求、用户决定和取消仍由云端控制
合同处理；不能仅在内存 Promise 上等待用户，也不能让 Projector 分区 handler 等人。
这不意味着开放用户扩展代码到 Worker。

## PI-06 · P2 · 项目文本指令缺少明确的资源加载通路

**源码确认的能力差距；模型偶然主动读文件不等于平台合同。**

Pi coding-agent 的 `loadProjectContextFiles` 按目录读取 AGENTS.override.md／AGENTS.md 等，
再交给 system prompt 构建。Cloud 当前 [BASE_SYSTEM_PROMPT](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts#L110)
和 [prompt 装配](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts#L789) 只合并平台说明、
语言规则和可选 agentSystemPrompt；Runner／guest 入口没有对应的项目文本发现与注入链路。

这意味着仓库编码约定是否被遵守依赖模型自己找文件。固定工具、禁用用户可执行插件，
并不必然要求禁用纯文本项目指令；二者应分开决策。

建议：提供有界、可溯源的项目文本资源读取端口，明确层级、字节限制、更新时机和上下文权限。
从选定 guest／安全 Workspace 读取通路取数据，不能让 Runner 在宿主文件系统加载项目扩展。
也需保持纯聊天不因资源扫描被迫激活 Cube。该能力目前未承诺，不能记为已有功能回归。

## PI-07 · P2 · 工具并发被包装层整体关闭，连独立只读和直接委派也受影响

**行为差异已复现；是否开放并发仍属设计决策。**

原生 Agent 默认 parallel，并支持原生 Tool executionMode。
[Cloud runtime 默认值](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L446) 是 sequential；
[四个远程工具](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts#L471) 又统一标成 sequential。
因此同一模型响应里的多个 read、或多个直接 subagent 调用，也要逐个等待。
并发委派只能再进入 workflow 脚本路径，而后者需要 Bash 和 Cube。

两个独立 fixture Tools 的原生最大并发为 2，Cloud 为 1。
这不证明生产吞吐倍数，也不建议把任意 write/edit/bash 全部并行。

建议：把每 Lane 的 Run 排序、单 Session 写入者与 Tool 内部执行策略区分清楚。
利用 Pi 自带策略，为明确可并行的工具验证有界执行，保留实际需要的顺序。
先修 PI-01／PI-02，再验证并行 intent、取消、结果次序和 sibling failure。

## PI-08 · P2 · 采样准备依附远程工具工厂，造成无文件工具分支整套复制

[createTrustedRemoteAgentTools](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts#L243)
同时负责远程执行、工具次数预算、system prompt、World State 注入、Step capture 和模型请求头。
[RemoteToolSandboxTurnRunner 的 toolFree 分支](../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts#L521)
又复制了 Step 序号、sampling attempt、重复事实判断、maintenance headers 等逻辑。

实例化 Agent 的工具集合还会追加 preview／subagent／supervisor，而 Cloud Step 的 activeTools
只来自四个文件／Shell Tool 的列表。当前代码用它表达文件工具授权，尚未证明会授权越界；
但命名和职责容易使后续策略误以为它是模型实际看到的完整工具集合。

建议：在现有 Runner 包中抽出一个采样上下文／World State 适配器，普通聊天和编码共用；
远程 Tool 工厂只负责 schema、参数和执行通路。明确区分完整 Tool registry 与文件工具 grant。
不需要新增服务、持久状态或另一个 Agent loop。

## PI-09 · P2 · 模型重试横跨三层，次数与等待时间缺少统一预算

[Runner](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts#L809) 关闭 Pi transport retries，
却启用 CloudAgentRuntime 的两次可见重试；[Model Gateway](../../packages/supervisor-host/src/model-gateway.ts#L754)
每个逻辑请求又最多发送三次；[CLIProxyAPI 生成配置](../../scripts/init-production.mjs#L324)
还有 `request-retry: 3`。

Gateway 的 `requestsStarted++` 在其重试循环外，Cloud 的 sampling Record 也看不到该循环中的
每次发送。匹配多层条件时，一个可见 sampling retry 可能展开为多次上游请求；不能把
`maximumRequestsPerRun` 当作严格供应商调用上限。已存在 `upstreamAttempts` 日志，故不是
完全不可观测；本轮也不把这些配置简单相乘后声称实际一定发送某个固定次数。

建议：明确 transport reconnect、凭据路由重试与新 sampling attempt 的所有者；共享总 deadline
和请求预算，保留必要的模型错误分类。不要再增加第四层 retry，也不能把未知工具效果纳入重试。

## PI-10 · P2 · 冷历史、服务端实时投影和浏览器 reducer 重复定义展示语义

**具体漂移已复现。**

同一 Tool／Compaction 的状态分别在 canonical-pi-conversation、conversation-turn-projection
和 web-ui/session-view 转换。PI-02 的 Tool 身份假设也同时出现于这三处。
另一个独立例子是 [冷历史投影](../../packages/runtime-core/src/canonical-pi-conversation.ts#L220)
把每个成功 Compaction 都标为 `threshold`，而 [Runner](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts#L862)
实际上将 overflow 原因记录在原生 step_attempt 中；历史查询只取 tool_started Records。

本地探针：实时投影是 `reason=overflow, estimatedTokensAfter=10`，同一完成状态的冷历史
变成 `reason=threshold` 且没有 after 估算。不是模型上下文丢失，但刷新改变了用户看到的语义。

建议：在不把 Pi schema 暴露给浏览器的前提下，收敛 PiCloud presentation 的共享规则；
从必要的原生边界记录恢复原因，或在未知时诚实标记未知。补同一 trace 的 live、snapshot、
reload、export 对照测试，避免各写一套预期却彼此不比。

## PI-11 · P2 · 会话列表只有截断标记，没有读取后续会话的协议

[ConversationReader](../../packages/control-plane/src/conversation-reader.ts#L110) 读取最近 101 条，
返回前 100 条及 `truncated`。Controller、API client 和 UI 没有列表游标／下一页入口。
单个会话的 Turn 历史已有分页，但它解决不了第 101 个独立会话的发现。

影响：旧会话仍在 PG，有 ID 仍可读取，但无法通过普通列表找回。长期使用时，持久化能力与
产品可访问能力脱节。建议补租户范围内的稳定列表分页／查询合同，不提高一个更大的硬上限来掩盖。

## PI-12 · P2 · GitLab 注释同步把远端等待放在持有业务行锁的 PG 事务里

[reconcileNextClaimSync](../../packages/control-plane/src/source-control-service.ts#L814)
锁住 Issue job 后，在事务中调用 [find/create/update note](../../packages/control-plane/src/source-control-service.ts#L2084)。
单次 GitLab HTTP 请求默认超时 30 秒；该等待期间保留连接和行锁。Coordinator 的同一个 tick
还先等待注释同步，再处理 Issue-to-Run 工作。

代码明确记录了这个低流量选择，用行锁防止注释创建并发和旧快照覆盖。因此这是有意取舍的
改进项，不能直接去掉锁后宣称问题解决。影响是 GitLab 变慢会拖住该 job 的认领／启动，
并延后该 coordinator 的其他 Issue 工作，不是所有普通聊天被全局锁住。

建议：若继续维护此可选功能，以有界版本／认领记录取得待同步快照，提交事务后发远端请求，
按版本确认完成；保留 marker 与更新合并，覆盖成功但回复丢失。不引入第二套 Run 调度器。

## PI-13 · P2 · 全量部署仍把 guest 模板版本绑定到整仓 HEAD

**9 月 20 日审查已有、当前仍存在的继承问题，不算本轮新发现。**

[production:deploy](../../scripts/run-production-deploy.mjs#L41) 总是进入模板注册，
[模板复用判断](../../scripts/register-cubesandbox-tool-template.mjs#L389) 要求
`previous.imageRevision === 当前整仓 Git revision`。仅文档／前端变化也可能使全量发布
重建 guest 模板，加大模板 churn，并触及已有的 Cube 模板清理问题。

建议：将 guest 构建输入、工具协议兼容性、整个平台发布 revision 分开描述，以构建输入
指纹或独立 runtime release 判断复用。不能删除镜像／协议一致性检查，也不能误称普通 `up`
必然每次重建。变更发布合同前需要专门的决定与升级／回滚验证。

## PI-14 · P2 · GitLab 同步的去重查找只看最新 100 条注释

**源码确认的条件性错误，未对外部 GitLab 发起写入。**

[findIssueNote](../../packages/control-plane/src/gitlab-project-client.ts#L243) 只请求
`per_page=100` 的第一页，找不到 marker 就返回 undefined；调用方随后创建新注释。
当旧 PiCloud 注释后面已有 100 条较新的注释时，旧 marker 仍然存在，但同步会再次创建。
PI-12 的 PG 行锁能够防并发创建，不能补足远端查询范围。

建议：保存并验证已创建 note 的远端 ID，使用明确的分页／找回策略处理首次绑定和删除后的
恢复；不能把“本页未找到”当成“远端不存在”。补带第二页 marker 的 fake GitLab 合同测试。

## 应保留的设计与未计作缺陷的差异

- Worker／Cube 分离、固定可信 Tools、PG Run 权威、单 Session writer、共享 family slot、
  独立公平模型 permit 有明确作用，原生本地 Pi 没有分布式归属职责并不意味着应删掉它们。
- commit-before-dispatch、seal、UNKNOWN、不自动重放 Shell 是已经接受的效果语义。
  Kafka reply 并不是恢复死亡 Loop 的 Promise。审批也不能靠重放工具来“继续”。
- 临时 Tool progress 的 HTTP/SSE 分流正确；不建议为对齐 `onUpdate` 把它重新持久化或送回 Worker。
- 当前高层 Pi Harness 不可直接替换 CloudAgentRuntime；应减少手写语义的偏差，而不是机械迁移。
- Fork 的独立物理 Session、委派 Lane、Volume 字节权威、开发机与弹性环境不同寿命均有当前 ADR。
  shared Workspace 上的并发文件修改是普通 Linux 并发，不应恢复全 Workspace 写锁。
- 弹性环境遇到执行通道不确定性可能销毁共享 Cube，波及同环境任务；ADR-0136／0151 已明确该取舍。
  本轮没有把它当成新发现的跨 Session 任意销毁漏洞，也没有证明物理效果 fencing。
- Provider hosted-item 适配、DeepSeek phase 限制、图像输入延期、外部 TLS GitLab 验收、多机 HA、
  Cube Volume／模板残留问题已经在 BACKLOG。没有把它们重新包装成新 bug。
- 未发现需要增加新的消息中间件、workflow engine、缓存或控制服务的证据。

## 覆盖清单

| 范围 | 本轮检查重点 | 结论／关联 |
| --- | --- | --- |
| sandbox-supervisor | 原生 Agent 装配、sampling、retry、Compaction、Record、remote Tool、Subagent、控制与取消 | PI-01、04–09 |
| pi-session-postgres | hot writer、Lane 视图、冷恢复、PG repo/storage、精确投影、重建、官方 backend conformance | PI-01 的语义测试缺口；未把该问题说成 backend suite 已失败 |
| trusted-tool-runtime | 委派 key、调用寿命、原生 Lane、workflow host calls、parent messaging、preview | PI-02、07、08 |
| supervisor-host | 原子领取接入、family capacity、模型 permit、Model Gateway、boot ledger、drain | PI-09；现有 lease／capacity 分工保留 |
| runtime-core | queue、执行／取消、seal、recovery floor、Projector、retention、native/public projection、SSE | PI-02、03、10 |
| event-log | Kafka consumer／rebalance、commit-before-effect、boot reply mailbox、producer capacity | PI-03；不回退成结果轮询 |
| tool-broker | binding/compute 寿命、授权、Cube adapter、命令路由、临时 progress、workflow、Volume、terminal/preview | PI-03、04；共享 Cube 故障范围是已有取舍 |
| tool-sandbox | 原生 Tool 复用、read/write/edit/bash、裁剪、进程与信号、guest 协议 | PI-03、04 |
| control-plane | auth、admission、conversation/tree/fork/prune、Steer、Subagent controller、机器、Issue、preview/terminal | PI-02、10–12、14 |
| protocol | 公共模型、内部执行 envelope、Tool schema、事件身份、frame／payload 边界 | PI-02、03、08、11 |
| database | schema 类型、当前迁移终态、锁／时间、SQL retry、通知；历史迁移按升级链检查 | 没有据旧表名恢复旧拓扑 |
| domain | Run／Turn／Session 状态与模型配置约束 | 区分任务状态、执行归属与原生模型 Step |
| web-ui | API、列表、tree、stream parser、reducer、Markdown、Tool preview、export、资源页 | PI-02、10、11 |
| workspace-runtime | seed 格式、有界输入、初始化与不覆盖既有文件 | 不是第二个 Workspace checkpoint authority |
| cube-api-authorizer | 管理 API 范围、凭据匹配、固定资源路径 | 未新增已确认问题 |
| cube-egress-gateway | 地址策略、代理转发、DNS、动态配置、连接生命周期 | 未新增已确认问题 |
| provider-egress-relay | 固定域名出口、CONNECT、超时与凭据边界 | 与模型 retry owner 区分 |
| ssh-gateway | 一次性 ticket、owner 校验、terminal bridge、输入输出与关闭 | 独立产品授权，未混入 Agent Run |
| observability | 指标、stage timing、trace、日志字段屏蔽、基数 | PI-09 的实际 attempts 已有日志；延迟不归因于单一存储指标 |
| fake-model-server | 测试注入、合成 stream、Tool／错误情景 | 保留确定性验证，不是生产 fallback |
| scripts／deploy／CI | Compose、Dockerfile、Helm/KEDA、NetworkPolicy、installer、guest template、依赖硬化、测试门禁 | PI-03、13；渲染检查不代表物理多机验证 |
| 文档／ADR／报告 | 当前索引、已知延期、历史审查与已完成修复去重 | PI-13 标记继承；没有修改现行 ADR |

## 验证记录

本轮仅修改审查记录与 backlog；没有修改产品实现、部署配置、生产数据或调用付费模型。
本地 fixture 在独立临时目录创建并清理。Kafka 仅只读查询 Topic 配置。

| 验证 | 本轮结果 |
| --- | --- |
| `npm run check` | 所有 workspace 类型检查通过；**1,082 tests passed，107 opt-in skipped，0 failed** |
| 原生语义／适配探针 | Record attempt、Tool ordinal、Subagent ID 复用、展示合并、路径与 symlink、工具并发、hook、Compaction 重建差异、payload 大小均得到预期证据 |
| `npm run helm:check` | Worker／平台 charts、分布式配置和 preflight 检查通过 |
| `npm run runtime-policy:check` | timeout 与模板 retention 检查通过 |
| `npm run image:closure-check` | 9 个 Dockerfile／185 个 COPY 源检查通过；不等于重新构建 9 个镜像 |
| `npm run observability:check` | 通过 |
| `npm run docs:check` | 通过；审查附件链接另行核对 |

[基线探针结果](pi-alignment-review-20260926-probes.json) 来自合成模型、临时文件和 stub
控制／数据库端口。原临时脚本断言“基线缺陷存在”；修复后已删除该过时脚本，相关场景转为
维护的 Runner、Subagent、canonical-history 和 guest Tool 回归测试，见修复记录。
Record 测试读取 pinned Pi 的内部 reducer 作为审查参照，没有向生产添加该私有依赖。

Kafka 上限来自只读 `kafka-configs.sh --entity-type topics --entity-name pi-cloud.execution-log.v10
--describe --all`。使用的 Platformatic 编码器默认不压缩，当前 Producer 没有设置压缩。
本轮没有将超限 native Entry 发往生产验证跨 Run 故障；该后果来自大小证据及错误传播代码。

第一次本地测试被执行沙箱拒绝监听端口（`listen EPERM`），中止后在用户开放权限的环境
完整重跑并通过；第一次不算产品失败或成功验收。107 个 opt-in 用例、真实模型／Cube、
独立多机、吞吐／容量和生产故障注入均未在本轮重跑。历史付费验收结果没有冒充本轮结果。

## 建议处理顺序

1. 先处理 PI-02／PI-03：避免抑制真实工作、混淆历史和放大单项 payload 失败。
2. 修 PI-01，建立“Pi 原生语义＋云端边界”组合合同测试；不是只验证 SQL CRUD 或 transport callback。
3. 沿 PI-05／PI-08 收敛 Runner 的 hook 和采样准备职责，再分别决策项目指令、路径语义与工具并发。
4. 统一 retry 预算与 presentation 规则，补长期会话发现；可选 GitLab 和模板发布单独做垂直切片。

每一项都可以在现有进程和端口内完成小范围改进；涉及公共协议、文件策略或持久化合同的项，
先由 owner 确认设计并记录 ADR，再实施。这里不是一次性重构全部模块的施工计划。
