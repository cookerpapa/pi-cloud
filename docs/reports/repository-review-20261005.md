# 全仓复审：恢复证据、取消结果与故障隔离

审查基线：`5c2fcab4fc47dfde5ca69afdc4703248a78d0fee`，2026-10-05。
本轮完成全仓边界审查、固定版本 Pi 对照、隔离复现、SQL 计数及部署来源核对。
交付内容是审查报告和复现工具；没有修改运行时代码、Cube 补丁或线上部署。

后续实施与当前状态见[改善记录](review-improvements-20261005.md)。本报告保留审查时的基线和结论。

## 结论

确认 **4 项行为问题，均为 P2；另有 1 项 P3 文档问题**。
最先处理 Volume 失败恢复和控制器租约的故障隔离，其次补齐两条 Tool 结果处理路径。
当前没有证据表明需要替换 PG + Kafka + Pi + Cube 的整体架构。

| 编号 | 优先级 | 问题 | 本轮证据 |
| --- | --- | --- | --- |
| R05-01 | P2 | Attach 失败后的清理元数据无法被实际 POSIX 插件接受，Volume 永远不能确认已清理 | 真实 Bolt、原生 Manager/binary adapter、仓库实际 POSIX 脚本 |
| R05-02 | P2 | 一个资源行等待阻塞公共 owner 的续租，使同一控制器的其他生命周期操作失去授权 | 当前完整 schema 的真实 PG、两个独立 Workspace |
| R05-03 | P2 | Stop 收到明确“未开始执行”的回包，仍被改成 UNKNOWN | 实际 CompletionAdapter → Mailbox → 取消等待器 |
| R05-04 | P2 | Workflow 的基础设施 UNKNOWN 没有触发后续采样阻断 | 实际远程工具适配器和本地 WebSocket，固定 Tool 路径作对照 |
| R05-05 | P3 | 当前架构文档仍描述已删除的 Volume 增减计数机制，并把含删列的迁移称为 additive | 当前文档、ADR、迁移补丁交叉核对 |

这四项不是同一个故障的重复计数：分别涉及 Volume 持久恢复、公共控制权可用性、已确认
取消的结果语义，以及另一条工具路径遗漏基础设施错误处理。以下说明各自证明到的层次。

## 范围、基线与方法

[覆盖清单](repository-review-20261005-coverage.json)记录 1,521 个基线跟踪文件、
22 个工作区、366 个运行时文件和 103,267 行运行时内容。包级静态导入未发现环。
清单、函数/风险扫描和测试覆盖不等于逐行形式化证明；人工审查按下面的边界展开。

| 工作区 / 范围 | 人工展开的边界与验证 |
| --- | --- |
| sandbox-control | 生命周期授权、创建/关闭、控制器换主、恢复缓存、共享 VM、绑定内存视图、健康巡检、Volume 删除、固定 Tool 与 Workflow 分派 |
| sandbox-supervisor | CloudAgentRuntime、Pi hooks、工具意图合并、取消、输入排队、失败前文本、重试/Compaction、世界状态与后续采样阻断 |
| supervisor-host | Worker 启动/退休、family 容量、模型许可、冻结请求策略、回包等待和可信工具组装 |
| runtime-core | 接收/准入/结算、Session ingress、同队列封口、Projector dispatch commit、重放与换主、Outbox、观察与权威分离 |
| event-log | Kafka 事务发布、分区消费/暂停/恢复、提交位置、boot 回包、Mailbox 和投递失败 |
| pi-session-postgres | 单 writer、发送前拒绝与发送结果不确定、Lane 查询、最新 Compaction 冷读、投影和删除、不可变 payload 缓存 |
| database | 当前 schema 建库、租约/锁时间、连接错误、只重试已确认回滚的事务、历史迁移与当前结构的区分 |
| control-plane | 输入接收/停止/编辑/排序/恢复、会话树/fork/删除、Workspace 切换、上传、租户边界、代码托管协调 |
| subagent-control | 子任务准入与幂等身份、同物理 Session/Lane、父子通信、结果/请求和本地模型许可的关系 |
| session-attachments | S3 字节与 PG 引用、图片编解码、流式验证、上传 claim、未封口 Run/草稿可达性、GC |
| workspace-runtime | 文件名/目录身份、临时文件、摘要校验、独占发布、fsync 和重试不覆盖用户改动 |
| tool-sandbox | 固定 Pi 文件工具、Bash 进程组、前后台进程、操作取消管道、图片处理、异常清理 cgroup 边界 |
| web-ui | 快照优先 SSE、重连、最终输出、输入队列、附件草稿、Workspace 选择、终端连接、运行状态和过期观察 |
| protocol | 有序控制引用、执行位置、Tool 结果/失败类型、图片引用与传输限制、公开 API/内部 Pi 事件边界 |
| domain | 状态转换、模型设置、产品配额与传输/内存保护的区分 |
| observability | 非权威观测、日志输出、指标采样、健康状态和生命周期决策的分离 |
| cube-completion | 原生结果解析、结构化执行失败、图片外置、进度旁路和 Kafka 回复 |
| cube-api-authorizer | 管理路径限制、凭据处理、请求失败不授予权限 |
| cube-egress-gateway | 配置更新、代理连接/关闭、地址边界和请求超时 |
| provider-egress-relay | Provider 隧道、DNS/地址验证、连接与模型请求生命周期 |
| ssh-gateway | PG 时间的一次性 ticket 消费、终端就绪/断开与通道收尾 |
| fake-model-server | 合成模型协议、工具/错误/流式场景与真实 Provider 验收的区分 |
| Cube、交付、文档 | 四份固定补丁、原生分配/执行/Volume、真实插件契约、构建来源、Helm 渲染、安装/运行策略、当前 ADR 和过时表述 |

Pi 比较对象是实际安装的 `@earendil-works/* 0.84.1`，不是网上另一个版本的印象。
Cube 以 `8721dd151971ce3c2966482bbd32904ad98f378e` 和
[runtime-build.json](../../deploy/cubesandbox/runtime-build.json) 的四份校验过的补丁为准。
原生实验通过 `git archive` 导出到临时目录，没有修改操作者的 Cube 源码目录。
本轮没有声称审查了 Cube 上游所有无关功能。

部署只做读取：Control Plane 1/1、Worker 2/2、Cube Master/API/Node 均就绪；
应用镜像为 `review-boundaries-v7-app`，原生镜像为 `review-boundaries-v7`；
managed protocol 7、guest protocol 3、patch ID `0d27a51febdc87d9`，
completion source `0d36631cd419e04c29e52dc73d9d89d96c9d7e1b`。
当前工作树没有运行时代码差异。更早的真实 Luna/VM 验收属于
[前次发布证据](review-repair-20261005.md)，不计为本轮重新执行。

## R05-01：Attach 回滚留下无法执行的 PendingDetach

位置：[allocation 补丁](../../deploy/cubesandbox/patches/0004-recoverable-vm-allocation.patch)
9437、9517、9714、9730；导出后的 `Cubelet/plugins/volume/manager.go` 139–155、204–229，
`refcount/store.go::Release/BeginDetach`；
[固定 POSIX 插件](../../deploy/cubesandbox/cube-volume-picloud-posix.sh) 209–212。

原生 Manager 先持久化 Acquire，再调用插件 Attach。插件失败时，旧的回滚调用仍是
`Release(namespace, volumeID, sandboxID)`；新的 Release 实现会转为
`BeginDetach(..., nil)`，持久化一个没有 metadata 的待清理记录。

恢复时 binary adapter 把 nil metadata 序列化成 `--metadata '{}'`。实际 POSIX 脚本
只接受空字符串或 `{"driver":"picloud-posix-v2"}`，因此每次 Detach 都拒绝。
后续 ObserveReference 和 Attach 都先尝试这个无法完成的清理：引用数虽然为零，
`confirmed` 始终是 false，新 VM 也不能继续挂载。删除保护正确保留了这份不确定状态，
但系统没有能让它自动收敛的路径。

例子：VM 创建已走到 Volume Attach，此时原生创建期限耗尽，或插件执行失败。
重试创建时，该 Workspace 会一直卡在恢复清理；等待更久不能补出丢失的元数据。
这里不是说普通 HTTP 客户端取消必然中止已由 Cube 接管的创建。

复现（归档于 `13344042` 的 `scripts/review-20261005-cube/attach_recovery_test.go`）：真实 Bolt 上使用实际
Manager 和 binary adapter，以已经取消的 context 触发首次 Attach 失败；连续三次观察都
得到零持有者但不能确认清理，第二个 Attach 也失败。直接传入正确 metadata 的 POSIX
Detach 成功，排除了插件本身不可执行。实验不创建 VM、不触碰真实 Workspace 字节。

建议修复：统一“Attach 没有成功返回”和“正常 Detach”在固定 POSIX 插件上的恢复契约。
明确未进入物理挂载的回滚，与可能已经有物理效果的清理；在需要清理时，持久化可重试的
参数。实际插件也必须接受该契约下合法的初始化失败状态。不能简单删除 Pending、强行归零
或把未知第三方插件的 Detach 当成成功。

验收应组合 Manager + binary adapter + 实际脚本，覆盖 Attach 前取消、Attach 失败、
写入失败、节点重启后恢复和另一个仍在持有同一 Volume 的 VM。

## R05-02：资源行锁等待挡住公共 owner 续租

位置：[WorkspaceRuntimeStateRepository](../../packages/sandbox-control/src/workspace-runtime-state-repository.ts)
314–317、1978–2022、2025–2057；
[数据库连接配置](../../packages/database/src/client.ts) 40–57。

近期修复正确增加了 owner 行锁：生命周期事务先 `FOR SHARE` 锁住控制器 owner，再修改
具体资源，提交前按 PG 时间复查。问题是这个 SHARE 锁也与续租的 `FOR NO KEY UPDATE`
冲突，而资源锁等待没有独立的短预算。

可以发生这样的顺序：

1. 一个连接暂时锁住 Workspace A 的资源行。
2. A 的 Close 已获得公共 owner 的 SHARE 锁，等待 A 的资源行。
3. 控制器 heartbeat 想更新 owner，反过来等待 Close 释放 SHARE。
4. 等待超过租期后，Close 被最终校验正确回滚，但 heartbeat 也无法续活过期 owner。
5. 完全没有被锁住的 Workspace B，其生命周期操作同样被 `ownership_lost` 拒绝。

真实 PG 复现（归档于 `13344042` 的 `scripts/review-20261005-owner.test.ts`）使用完整迁移和两个独立 Workspace，
缩短到 1.5 秒租期、100ms heartbeat，观察到资源操作和续租两个锁等待。PG 本身仍能正常
执行查询；释放 A 的锁后，B 的 Close 与 owner health 检查仍失败。生产默认是 15 秒租期、
5 秒 heartbeat；复现缩短了时间，没有改变锁冲突关系。

这是可用性和故障隔离问题，不是要求删除上轮补上的并发保护。已经由 Cube 接管的 Tool
不会因此必然停止；被扩大的影响范围是同一控制器的新建、关闭和恢复等生命周期操作。

建议修复：对持有公共 owner 锁的生命周期事务规定短且可证明的等待/执行预算；资源繁忙时
及时回滚并由现有控制重试收敛，给续租留出余量。再审查资源锁和 owner 锁的统一顺序。
保留提交前的 PG 时间、身份与 CAS 检查。不能把 SHARE 直接换成允许所有 owner 更新的锁，
也不能允许已经失效的 owner 自动续活。锁顺序/预算契约需要补入 ADR-0224。

验收必须同时验证：旧 owner 不能提交、A 阻塞时 B 仍可工作、heartbeat 可继续、长查询
在租期内退出，以及主动 retirement 与 admission 的竞争。现有“等到过期后回滚”用例只
证明前一半，没有证明续租和其他资源能继续。

## R05-03：明确未执行的取消被变成 UNKNOWN

位置：[取消等待器](../../packages/sandbox-supervisor/src/tool-cancellation.ts)，
[远程 Tool 适配器](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts) 320–389，
[CompletionAdapter](../../packages/cube-completion/src/adapter.ts)，
固定 Cube `pkg/execution/manager.go::execute`。

Cube 对尚未进入 driver 的取消会返回 `tool_cancelled`。例如两条大 Read 占住许可时，
第三条 Read 在等待阶段被取消。CompletionAdapter 正确转换为结构化
`effect: not_started`，Mailbox 以 `ToolExecutionFailure` 拒绝等待 Promise。

取消等待器却把“AbortSignal 已取消时 Promise 被拒绝”一律当成回包无法确认，替换为
`TOOL_CANCELLATION_UNKNOWN`。适配器的 `received` 也只在 Promise 成功 resolve 时置位。
明确的负面回包被当成没有收到回包，触发 `onToolCancellationUnconfirmed`。

例子：用户停止一条尚未开始的 Read，系统已经知道文件读取没有执行，下一轮上下文仍说
结果/效果不确定，并走额外的未确认收尾。这不符合当前的结构化失败契约。

复现（归档于 `13344042` 的 `scripts/review-20261005-cancellation.test.ts`）串起实际 CompletionAdapter、Mailbox
和取消等待器，断言最终 UNKNOWN 的 cause 正是 `effect: not_started`，且未确认回调触发。
原生未进入 driver 的分支来自固定 Cube 源码；本轮没有为此新建真实 VM。

建议修复：区分“收到权威终态”与“Promise resolve 成功”。结构化 not_started 应保留其
明确语义；真正失联、超时和 `effect: unknown` 仍按 UNKNOWN 收尾。正常 Bash 的 native
错误仍由 Pi 处理，不根据错误文本猜测 VM 状态。

验收增加 Stop 与 not_started 回包的先后顺序、同 tick 竞争、最终普通 Tool 错误、真正超时，
并确认不会误触发未确认清理，也不会追溯停止已经完成的后台进程。

## R05-04：Workflow 没有使用同一套基础设施失败处理

位置：[远程 Tool 适配器](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts)
370–418、560–591；[Workflow transport](../../packages/sandbox-supervisor/src/workflow-transport.ts)；
[Turn Runner](../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts) 625–648。

普通 `tool.execute` 捕获结构化 unknown 后，会调用 `onToolOperationUnavailable`。
这个回调记录沙箱不可用、设置 `toolRuntimeFailure`，后续 captureStepContext 拒绝继续采样。
`workflow.exec` 直接返回 readWorkflowResult，没有经过这个处理。

例子：模型用 subagent 的 workflow 编排子任务，执行或回包连接失联，Worker 收到明确
`ToolExecutionFailure(effect: unknown)`。它作为普通 Tool 异常返回 Pi，缺少固定 Tool 路径
会设置的采样阻断；模型可能继续请求或生成新的工作，尽管该 Workflow 的效果还没有确认。
这不是证明 Projector 自动重放了旧 Shell，也不是断言所有 Workflow 业务错误都该终止 Run。

复现（归档于 `13344042` 的 `scripts/review-20261005-workflow.test.ts`）把同一个结构化 unknown 分别交给两条
实际适配路径。固定 Tool 调用不可用回调一次，Workflow 零次；Workflow 使用真实本地
WebSocket 连接。后续采样阻断依赖该回调的事实已从 Turn Runner 核对。本轮复现没有请求付费模型。

建议修复：让两条路径共用基础设施失败分类和 Run 阻断策略，保留各自的传输和执行生命周期。
普通脚本/业务失败继续作为 Tool error；结构化 unknown 和未确认的连接中断进入明确的
不可用/未知处理。无需新建 Broker、操作结果表或另一个任务系统。

验收覆盖 Workflow 确认成功、业务错误、not_started、unknown、WebSocket 提前关闭，以及
UNKNOWN 后确实没有第二次模型请求。不要只验证普通 Bash 的错误字符串隔离。

## R05-05：当前说明仍混用旧的 Volume 记账机制

[ARCHITECTURE.md](../ARCHITECTURE.md) 671–672 仍说 allocation receipt 与 Volume
reference transition 一起提交，以防重复应用计数。ADR-0226 已明确改为持有集合/版本状态
对账，旧增减记账已删除。这段现在会误导维护者把恢复入口放回回执计数。

[ADR-0226](../adr/0226-recoverable-volume-reference-state.md) 65–66 又把迁移称为 additive；
实际迁移删除 `create_refs_applied` 和 `close_refs_applied` 两列。ADR 后面确实要求匹配
metadata/binary restore 才能回退，但前面的 additive 描述仍不准确。原生 Manager 注释
也残留“Detach 失败重新 Acquire”的旧说明。

建议在修复提交中一并统一为当前的状态对账和匹配版本回退流程，保留按版本归档的历史报告。
本轮先记录矛盾，未把现有实现描述成已经完成下一轮修复。

## 与 Pi 的对照结果

| 行为 | Pi 0.84.1 | 当前 PiCloud 与判断 |
| --- | --- | --- |
| Agent Loop | Agent 调用公共 loop，模型流结束后准备/校验工具，执行后 finalize hooks | 仍实例化原生 Agent；CloudAgentRuntime 增加权威/持久化/恢复，没有补丁修改 Pi loop |
| Tool 意图 | 参数准备与校验在工具 execute 前 | Harness 在 execute 内生成 tool_started 和 prepared command，一起持久化；不是刚收到 JSON 片段就执行 |
| 最终 Tool Result | finalizeExecutedToolCall 后发出结果事件/message | Cube 回包是输入材料，Worker/Pi 处理后才进入 canonical native log，边界正确 |
| Stop | AbortSignal 传给正在运行的工具，等待该轮工具收尾 | 固定工具有序取消和有界等待合理；R05-03 是确认语义错误，不是这一架构应被删除 |
| Bash | 终止当前进程组；后台工作是否存活由其脱离/重定向方式决定 | 正常取消沿 guest Tool 进程组，不回溯管理全部历史命令；异常退休另有边界 |
| steer / follow-up | 原生队列在工具批次后或 Agent 将停止时消费 | 活跃输入走公开 Agent API；产品层 PG 队列保留编辑/排序/取消和 Stop 后暂停，属于已确认的云化差异 |
| retry / compaction | SDK 提供重试分类、compaction 准备/生成、上下文构造 | 云层持久化恢复与公共请求策略围绕公开接口；前次 Fast/维护请求修复仍在，没有发现该问题回归 |
| 冷恢复 | SessionStorage/Session 上读取需要的分支 | PG native log + 最新 Compaction 活跃后缀；没有恢复整份 lifetime JSONL 的路径 |
| UI 流式 | 原生事件/内容块 | final 文本流式发布，已识别 commentary 在块完成时展示；presentation 不改变原生完整消息 |

用户/项目扩展、审批产品 UI、物理节点 HA 没有被当作本轮缺陷。既定产品边界不同于缺失
原生 loop 能力；要扩展这些能力，应在现有公开 hooks/控制协议上设计，而不是改 Pi 内核。

## SQL、往返和精简方向

[本轮 SQL 计数](repository-review-20261005-sql.json)用隔离的完整 PG schema 和实际控制方法：

| 场景 | 客户端 SQL 往返 |
| --- | ---: |
| 首次接收输入 / 同幂等键重试 | 7 / 3 |
| Run admission | 11 |
| 接收 follow-up | 7 |
| 输入队列快照 / 一次变更刷新 | 1 / 1 |
| 已加载队列视图读取 1,000 次 | 0 |
| 已加载绑定视图查找 1,000 次 | 0 |
| Stop 并暂停现有输入 | 9 |
| 测试执行器结算 | 19，包含夹具模拟 drain 的 UPDATE |

计数包含 BEGIN/COMMIT，不包含 trigger 内部语句；未计 HTTP 鉴权、真实 Kafka/Cube/模型
延迟。绑定测量使用内存 source fixture，所以证明的是加载后的查找路径，不是整次 Tool
执行无数据库访问。这个范围与数字一起保存在证据中。

已有 Kafka 控制传播有实际收益，尤其是绑定、队列、子任务读视图。以下可继续优化，但不是
本轮已确认的行为缺陷，也没有把测量前的猜测写成性能提升：

1. **冷 writer 清扫合并查询。** `PostgresNativeSessionHost.#reap` 每 60 秒对每个无活跃 Lane
   的 writer 单独 SELECT runs。可以收集候选 lease IDs 后批量读取，再逐个确认本地引用未变。
   保留 PG 对是否仍有活跃 Run 的判断，不凭空用缓存授权释放。还应防止一次慢扫描与下一次重叠。
2. **Volume 锁随生命周期回收。** 原生 Volume Manager 的 `volMu` 是永不删除的 sync.Map，
   ObserveReference 也会创建锁；存储已回收不代表这张锁表回收。可评估复用 Cube 已有的
   `utils.ResourceLocks`，同时保留同一 Volume 串行及等待上下文。影响量未做长期负载测量。
3. **控制状态变化只做必要刷新。** 延续现有 version/epoch/read-view 设计即可。生命周期
   准入、closure、用户授权和 bootstrap 仍需 PG；不能因为工具路由查内存，就把这些也改为
   依赖可能延迟的 Kafka 通知。现有重复读取要先区分“同一快照内冗余”与“锁后重新授权”。

不建议为了减少一次 RPC，把任意 Shell 的分派 commit 移到外部效果之后；也不建议把大图
放回 Kafka。固定 Tool 的直接 Cube 接管、boot 回复、原生最终结果分层保留了恢复边界。

## 对架构的评价与需要讨论的取舍

当前主要职责划分是清楚的：Pi 决定 Agent 行为，PG 决定可执行控制状态，Kafka 保存有序
发布与封口，Projector 维护历史/视图并按提交位置路由，Cube 接管外部执行与物理生命周期，
Volume/S3 分别保存 Workspace 与会话图片。它有完整的数据流和恢复约束，已经超出简单
聊天应用；本轮结果支持继续打磨这个架构。

**仍然最贵的是维护跨组件契约。** 本轮问题集中在“结构化失败到了下一层后被怎么理解”，
和“局部保护会不会阻塞另一个职责”。没有包级 import cycle，并不代表运行时耦合很低。
把同一条失败策略放在一个明确的适配边界，比继续增加状态表、超时补丁和服务更有效。

**Cube 扩展应作为长期维护的基础设施适配器来管理。** 当前四份补丁中，执行与 allocation
两份补丁文本共约 1.75 万行，包含代码、上下文及测试，不能当成净新增代码行数。
统一 Helm 期望状态已经解决“发布完再 patch”的配置来源分裂；它没有消除原生接口、
MySQL/Bolt 状态、固定插件和回包协议一起升级的成本。后续应按已测需求收窄接口、跟踪上游
可替代能力、继续版本锁定和组合测试。没有证据支持现在为此另造一套沙箱调度/存储系统。

**单个物理 Session 与 Kafka 分区的隔离粒度是实际限制。** 同一个 Session 的提交不确定
仍可能需要停止其共享 writer；同一分区的故障记录仍可能延缓其他 Session。分区间的暂停/
重试隔离已有实现。本轮没有足够混合负载数据支持新增按 Session 的调度系统或拆出第二个
消费者。先监测 owner 锁等待、Projector 阶段耗时和分区停顿，再决定是否改变边界。

**Workflow 的生命周期与固定 Tool 接管不同。** 交互式 hostcall 当前依赖控制面的连接，
这是文档明确写下的取舍。R05-04 要统一失败策略，但不意味着应该把交互编排也做成另一个
可重放任务系统。若未来要求它在控制面重启后继续，需要先单独确定恢复语义。

## 验证、复现入口与限制

[验证摘要](repository-review-20261005-verification.json)记录本轮命令、退出码、范围与源码身份。

- `npm run check`：1,760 个断言通过（含 63 个 acceptance helper），9 个可选外部用例跳过。
- `npm run browser:presentation:check`：当前浏览器夹具的交互检查通过。
- `npm run build`、`npm run helm:check`、`npm run production:install:check`、
  `npm run runtime-policy:check`、`npm run image:closure-check`、`npm run dependencies:check` 通过。
- 文档链接检查、格式检查和证据 revision/计数一致性核对通过。
- `npm run cubesandbox:allocation-check`：固定导出源码、真实 Bolt/MySQL、race 检查通过；
  paused destruction 的 service composition 夹具使用 `CGO_ENABLED=0`，不是物理 KVM 测试。
- `npm run eval:faults`：178/178 个定向故障用例通过；
  [版本化结果](repository-review-20261005-faults.json)单列，不把定向夹具称为线上混沌试验。

当时新增的 review 测试是**现状复现**：它们通过表示缺陷在基线可重现，不表示问题已修好。
它们当时放在默认产品测试集外。后续修复已把期望行为纳入相应组件的回归套件；以下旧复现命令需在归档版本 `13344042` 上执行。

```bash
# R05-01：需要 Docker 和包含固定提交的 Cube 源码目录；只读导出，不修改该目录。
node scripts/review-20261005-cube.mjs

# R05-02：自动创建隔离 PG，并创建/删除本轮独有的数据库。
node scripts/run-with-test-postgres.mjs -- npx vitest run scripts/review-20261005-owner.test.ts --maxWorkers=1

# R05-03、04：内存传输组件和本地 WebSocket，不请求模型、不创建 VM。
npx vitest run scripts/review-20261005-cancellation.test.ts scripts/review-20261005-workflow.test.ts --maxWorkers=1

# SQL 计数：脚本现在读取实际 HEAD，避免重复运行仍写旧的固定 revision。
node scripts/run-with-test-postgres.mjs -- node --import tsx scripts/review-20261004-sql.mjs /tmp/pi-cloud-review-sql.json
```

本轮没有向真实 GitLab/GitHub 发送消息，没有做部署/重启/数据删除，没有使用付费模型。
没有执行物理节点掉电、多机 HA 或真实模型连续截图的压力测试。已有接受/重放/取消/恢复
夹具和浏览器测试仍不能代替这些验证。

还检查了同名 Volume 的代际更换：metadata 对旧回包的 generation 校验存在；插件 Destroy
接口本身只接收名称，物理效果窗口与重建同名资源的组合仍值得专门验证。当前 PiCloud 不
复用已删除的 Workspace 身份，本轮没有证明这一窗口能在产品正常路径造成数据丢失，
因此没有将它列为确认缺陷或擅自增加第二套删除协议。

部署入口在找不到 ready Cubelet 时直接失败；本轮确认其源码行为，但没有再次制造部署时的
短暂 readiness 竞争。可以补充针对期望镜像/Pod 的有界等待，现阶段作为交付改进，不宣称
已经复现新的线上故障。
