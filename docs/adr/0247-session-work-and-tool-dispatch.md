# ADR-0247: Session execution, native Subagents and unified Tool dispatch

Status: **implemented, verified and deployed**,
2026-10-14. Source baseline: f5c0d9d8. Serving release: session-work-6ac697f9.

业主已同意以物理 Session 为执行所有权边界、将普通子 Agent 交给原生 Harness
管理的方向，并要求回顾讨论、提出完整改造方案。本文件给出目标、实施顺序和
验收条件；业主随后明确要求实施。各阶段仍须通过验收，授权不等于协议已经验证。
尚未实施的 ADR-0246 已合并到本文，旧草案保留在上述 Git 提交中。
当前线上已使用本文的直写/原生子对话方案；第 14、15 节记录滚动验收发现及修复。
[实施记录](../reports/session-work-implementation-20261013.md)包含匹配部署、真实
父子任务/图片/流式交接、故障恢复和最终浏览器证据，以及停顿和容量测量的限制。

## 1. 目标与明确的取舍

云端接收一份工作，Worker 获得其物理 Session 的独占执行权；Pi Harness 推进
主 Conversation 及这份工作派生的普通子 Conversation。子 Agent 不再另建一份
云端 Run 去排队、领取和结算。原生任务状态继续由 Pi 保存和恢复。

统一本地 Tool 的远端派发和最终回包，但保持实际执行位置：

- Worker：固定 Pi Harness、模型端口、工具定义和通用代理、原生状态操作。
- Projector：同一消费组内的投影、派发和可重建视图；不等待长任务完成。
- 控制面处理器：subagent、监督者通信、preview 等可信云端业务。
- Cube：完整文件/Shell 工具，以及不可信 workflow JavaScript。
- Provider：hosted tools 保持服务商执行，不伪装成本地 Tool。

Worker 直接向 Kafka 发布原生提交，移除普通写入对控制面入口的依赖。
PG 仍是云端工作、租约和资源授权的唯一权威。控制面停机期间，工具派发、
历史投影和网页显示仍可能暂停；直写不等于无限期脱离控制面运行。
工具经过 Projector 会有传输成本，必须测量；不承诺所有改动都减少代码或延迟。

## 2. Session、Run、Conversation 的目标含义

| 概念 | 目标职责 | 生命周期 |
| --- | --- | --- |
| 物理 Session | 一份原生存储、共享日志和 Conversation 容器 | 跨多次用户工作长期存在 |
| Session lease / writer | 某个 Worker 运行、写入这个 Session 的资格 | 一次持有期间；接管后换代 |
| 云端 Run | 一份已接受的根工作及期间派生的普通任务 | 可以跨 Worker 恢复，不是 RunAttempt |
| Conversation | 一个 Agent 的对话、输入和上下文范围 | 可在执行结束后保留 |
| 原生 Task / Submission | Pi 的执行进度、输入处理和取消/恢复状态 | 由 Pi 的原生规则决定 |

目标是在同一物理 Session 内，一次只有一份活跃的云端根工作。初始用户请求
仍先登记 PG，再确认接受。Worker 可以从根 Run 队列发现工作，在同一领取事务
取得 Session 租约；不必为“领取 Session”另造一张调度表。子对话直接共享这份租约。
FOR UPDATE SKIP LOCKED、PG 时间检查、短事务和领取提交不确定时的身份核对保留。

运行期间的 follow-up/steer 仍进入 Pi Inbox，沿用浏览器保留未确认草稿的语义。
派生子 Agent 直接成为原生 Conversation/Task，不再走云端 Run claim。
当前 foreground-owned 产品范围不变：关闭的 Agent 收到内部消息仍可报告 missed，
不增加后台自动复活、跨 Worker Agent team 或永久占用 Worker 的冷 Session。
后续显式用户工作按初始入口登记新的根 Run；会话历史无需重建成新 Session。

一个 Worker 可同时持有多个物理 Session，各有自己的租约和 writer。
Worker 故障可能影响多个 Session，但它们分别完成关闭；不是全 Worker 共用一个封口。
模型并发许可仍由 Worker 按 Session 公平分配，仅覆盖实际模型请求。
子任务数/模型并发与 Session 槽位分开观测；等待子任务或工具不占模型许可。

## 3. 数据与身份的收敛

| 数据 | 保留/改造方向 |
| --- | --- |
| sessions / pi_sessions | 保留产品身份、物理 Session 和配置/资源关联；子对话展示记录可保留，不能再成为第二套执行状态机 |
| runs | 只登记根工作、初始输入/配置、取消请求和整体收尾；删除派生子 Run 的创建/领取/结算路径 |
| session_leases | 唯一续租和 writer 所有权；保留已关闭代次的恢复证据 |
| Pi 原生存储 | 保留完整提交、Conversation、Task、Submission、输入和工具结果；沿用 ADR-0243/0244/0245 |
| 子 Agent 关联/查询索引 | 来源调用、原生 Conversation、父子关系和展示定位；从已保留的原生状态构建，不调度任务 |
| subagent_control_commands | 删除普通工具调用的独立 start/wait 命令正文及回复副本；逐项迁出消息/监督请求/动态 workflow 的必要职责后删除旧表 |
| 资源绑定与控制 Outbox | 保留 PG 授权、不可变物理目标和故障清理；独立 compute 不依赖子 Run 才能存在 |

逻辑工作身份、原生任务身份、物理操作身份和 writer 代次分开：
根 Run ID 不充当 Tool operationId；原生 taskId 在物理 Session 内解释；
重试同一已登记效果沿用其稳定身份，不在恢复时重新随机生成一个子任务。
operationId 只关联一次回包，不能单独表示授权。

需要保留的子 Agent 来源、分叉点、配置引用和创建收据，通过 Worker 的公开
原生事务与相关创建一起记录。重建只读索引不能生成原生 ID、创建子对话或执行工具。
控制面仍持有真实资源授权，不能从日志里的数字推导一个新租约或绕过 Workspace 删除。

删除子 Run 后，所有调用方必须改用“根 Run + Conversation/Task”定位：
模型端口、输入/取消、工具路由、资源绑定、展示覆盖、历史查询、附件引用、探针、
恢复及清理。不要用隐藏的 child job/attempt 表重新做一套相同生命周期。
子 Agent 的模型/工具/cwd 配置继续冻结在原生配置及已授权绑定中；凭据不进入日志。
冷恢复先从原生关联恢复全部 Conversation 的工作/模型/环境绑定，再允许相关任务
发起请求，不能让它们永远等待已经删除的子 Run 入场事件。
资源绑定至少区分根工作、Conversation 和 compute scope；shared 与 ephemeral
子任务不能因为共享 Run ID 而被错误合并到同一个路由或取消范围。

## 4. 一个 subagent 调用的完整路径

~~~text
主 Agent 产生完整 subagent 调用
  → Pi 校验参数、运行 beforeTool
  → Worker 将原生执行意图与 PiCloud 派发描述同批提交 Kafka
  → Projector 投影、登记可重建的待处理引用
  → 控制面 subagent 处理器调用当前 Worker 的原生管理端口
  → Worker 幂等创建/配置子 Conversation，提交子输入
  → 同一个 Harness 调度子 Agent；子 Agent 无独立云端 Run
  → 原生状态变化更新子任务视图，处理器获得完成/阻塞/失败结果
  → 处理器组织工具结果，写入原 Worker 的 Kafka 回包通道
  → Worker 通用工具代理返回，Pi 执行 afterTool 并提交正式 Tool Result
~~~

普通 subagent.run 不再另外发布一条 subagent_command/start，再往返一次 wait。
完整 tool_call 的出现不等于获准执行：只派发已校验并提交执行意图的调用。
Pi 本身的多个合法 Storage 提交不强行合并，不修改/过滤已经提交的原生 batch。
派发描述引用同批原生参数，补充稳定调用身份、原生上下文锚点、处理器版本和
回复目标；不复制一份完整任务正文，也不把 Pi 私有状态机搬到控制面。

Worker 管理端口提供原生能力，而非 subagent 业务编排：
查找当前 Session、幂等创建/fork/configure、提交输入、读取原生状态和请求取消。
父子归属沿用当前“拥有者为请求方 generation”的原生关系，避免监督者回复死锁。
先记录创建收据，再以稳定 submission requestId 提交输入；两步之间崩溃也能去重。
有了子 Conversation 即可在当前根 Run 授权下运行，无需再通知全局 Run 队列领取。

原生解释留在 Worker 适配器。子任务状态视图由原生记录/公开读取能力推导；
单个 final assistant 或 Submission.done 都不直接代表整棵普通子任务树结束。
阶段 P0 必须证明不依赖子 Run 的 wait、blocked、父子取消和错误汇总。
不增加一个独立的 child completed 状态机来替代这项证明。
还要覆盖 delegation 调用中断后的子任务收尾，以及 blocked 后等待监督者回复的
合法继续；不能误杀后者，也不能遗留已失去管理者的前者。

实施采用 `subagent_conversations` 保存不可领取的关联与原生来源引用，
`subagent_executions` 改为读取 Pi Task/Submission 的 SQL 视图。`completing`
仍算未完成；普通 final 不提前宣布整棵所有权子树结束。`conversation_turns`
统一根工作和子对话的展示查询，不为子对话伪造 Run。原始 prompt 从原生意图读取，
不复制进关联行。子对话的展示游标放在关联索引，根工作的游标仍在 Run。
创建收据同时保存冻结的资源/工具选择；冷恢复只读取仍有活跃原生 Task 的对话。
取消与初始输入接纳由当前 Worker 的同一对话管理队列串行执行，必要的迟到创建
拒绝收据存入原生事务，不另建 PG 子任务取消队列。

工具绑定 ID 使用本次环境申请 ID，不能再借用根 Run ID。单绑定释放只关闭这个
绑定，不能调用整个根工作的路由关闭。Cube 现有 `runID` 字段是执行器的私有取消
范围；PiCloud 适配器传入绑定 ID，在自己的接口中称为 `executionScopeId`。
云端根 Run 保留在 completionContext 中。这样直接复用 Cube 已有的范围取消与
顺序拒绝，无需新增一套 Cube 调度或改变其 protobuf。
交互式 workflow 同样按绑定关闭；每个 Kafka 位置按 operationId 区分同批调用，
同一逻辑 Run 换 writer 后不继承旧 writer 的关闭标记。

重复管理请求可能发生。例如创建成功后 HTTP 回复丢失，同一请求仍返回同一个
Conversation；控制面替换后从当前投影继续处理。父调用已取消/终止或旧 writer
已关闭时，旧引用不能重新创建任务。Worker 也失效时先走 Session 关闭/恢复，
不能借控制器重试绕过 Durable 对 unsafe 工具的中断处理。

## 5. 派发索引、offset 和动态 workflow

待处理索引是原生执行意图的派生视图，可保留少量身份、源记录引用和交付元数据，
不能有另一份工具参数正文、原生任务队列或独立 continuation 决策。
引用需要指向保留的稳定记录；不能指望已过期的 Kafka 流式片段完成冷恢复。
执行恢复只处理当前仍有效的工作，不能扫描历史 tool_call 就重新执行。

实施时将必要派发描述保留在现有 pi_durable_commits 提交头的 cloud_metadata，
与原生正文/当前索引同事务写入并纳入提交指纹。参数仍取原生执行意图。
待处理集合由当前原生 Tool Task 和该提交头重建，不新建有独立运行状态的工具任务表。
不含控制派发的普通提交不产生这份元数据；这是既有提交的附属描述，不是第二条日志。

统一协议不代表所有副作用采用相同的重放策略：

| 类别 | 消费/恢复边界 |
| --- | --- |
| 原生状态与派生索引 | PG 投影原子提交、可幂等重放 |
| 创建子对话、输入投递等控制效果 | 持久化来源与必要引用后允许推进；接收端用稳定身份去重，控制器对仍有效请求重试 |
| 任意 Cube/Shell 效果 | 确认单调派发 offset 后请求 Cube 接管，不等执行结束，不因投影回放再次派发 |

同一 native batch 混合两类工具时，先完成原生投影和可恢复控制效果的引用登记，
再提交不可重放效果的派发 offset，最后调用 Cube。offset 不是执行成功证明。
Cube 接管仍要检查有界确认；提交 offset 后尚未交给 Cube 就崩溃的窗口保留 UNKNOWN。
Linux 的难点是副作用不能与 Kafka offset 原子提交，不是永远无法观察命令结束。
只读重建模式与可执行恢复模式必须分开，即使控制效果可以幂等也不能无条件重发。

workflow JavaScript 继续在 Cube。脚本运行中产生的 runs.run/send/cancel 等请求，
无法从最初那段脚本文本静态重建。每个实际发生的控制调用仍须由可信 Worker
持久化其稳定身份、参数来源和顺序，再交给同一 Projector/处理器。
这是新的运行时意图，不是普通 subagent.run 的重复 start/wait。
不恢复 JavaScript 堆栈，不自动重跑中断脚本，不将用户代码移到控制面。

保留 fresh/branch、shared/ephemeral、cwd、工具限制、递归、status/wait/cancel/send、
阻塞式监督者交互和 workflow 功能。未证明这些职责已迁走前，不能先删旧表。
必要的控制交付索引与资源状态可以在 PG；它们不能成为另一套 Agent 任务权威。

## 6. 工具结果统一走已有 Kafka 回包通道

Cube 和控制面工具处理器都组织 content/isError/diagnostics 等结果，经
PiCloud 自有 ToolReply 协议发送到原 Worker boot 的现有回包 Topic。
复用一个消费者和回调注册表，不增加控制工具专用消费组。
Worker 验证调用身份、还原图片引用，转成 ToolExecutionResult 后让 execute 返回。
Pi 继续处理 afterTool、输出边界和原生任务/Tool Result 的原子收尾。

协议显式区分业务工具错误、基础设施 UNKNOWN 和确定未开始。
Cube 的物理执行证据仅用于 Cube 回复，控制面回复不伪造 VM/进程证据。
保留 tenant、物理 Session、根 Run、原生调用、operationId、writer/Worker boot
关联；不使用 provider toolCallId 作为跨会话唯一身份。
重复或取消后的迟到回包不能复活旧 Promise、覆盖原生终态或投递给新 Worker。
等待者在派发提交前注册；快速控制回复可能先于原生产者收到 ACK，不能因此丢包。
提交明确未发送、提交未知和本地取消分别清理等待者，保留各自恢复语义。

删除 subagent 的 HTTP result 回调和专用等待表；创建/配置/输入等管理 HTTP 仍可用。
Kafka 回包是传输，不是另一份长期工具历史或跨 boot Promise 恢复机制。
控制效果可从持久化来源和原生结果重建通知；只重发通知，不重跑已经执行的工具。
需要冻结无法再次读取的结果引用时，应使用已有原生存储/附件边界，不新增 PG
原始工具结果缓存；不可确定的物理结果继续遵守原有 UNKNOWN 合同。

长 subagent 等待不能沿用 Bash 执行时限。当前 mailbox 的 Promise 由取消信号控制，
但回包保留期来自固定工具时限；需要审计调用时限、消息保留、背压与 boot 清理，
用“子任务运行超过一小时、回包后才短暂断连”验证，不能只让类型兼容就算完成。
工具 schema、处理器协议和本次请求所用版本必须匹配；默认保持 code-owned 工具目录，
不增加用户扩展加载。新增普通工具只增加定义和处理器，不新增 Worker 业务分支。

## 7. 完成工作与关闭 writer 分开

普通子任务结束或单独取消：Pi 保存自己的原生终态，兄弟任务继续；没有子 Run seal。
根 Run 的完成候选必须经过下列边界：

1. 当前根工作涉及的普通原生任务均已收尾；明确排除独立后台服务进程。
2. 已接受输入按原生语义处理/撤回；输入接纳和完成判定在线性化边界上互斥，
   并重查等待期间的新输入/子任务。不能只看主 Agent 的 final。
3. 所有属于本工作的原生结果和展示引用已确认提交；结果分类遵循原生/产品规则，
   可被模型处理的单个 Tool 错误不自动令整个 Run 失败。
4. Worker 用一次普通有序完成提交确认根工作边界，Projector 同事务更新 PG Run、
   terminal 展示覆盖和下一份根工作的就绪状态。不为完成再绕 PG Outbox 发布 Run seal。

完成描述是云端工作收尾，不替代 Pi Task 状态。先研究能否附在最终原生提交；
无法同批时允许一个普通 Worker 收尾提交，不能通过篡改原生 batch 省记录。
投影落后时不能提前开放下一份根工作。缺失完成 ACK 进入已定义的未知提交恢复。

本次切片保持当前“根工作结束后释放空闲 Harness”的产品行为，不新增空闲 owner
调度器。正常 Worker 的 `work_finished` 在停止接纳、加入全部子对话清理并排空后
提交，可同时携带该 owner 主动退役的证明；工作完成和 writer 关闭仍分别记录。
如果控制面已经请求强制封口，这条记录只确认工作结果，writer 的释放仍等待已
登记的封口，不能抢先开放新 owner。控制面迟到的恢复封口不能重排已经完成的工作。

Session writer 的关闭属于一次租约代次：所有子 Conversation 共享一个关闭边界。
正常释放执行所有权需证明已关闭接纳、排空并记录关闭位置；如果暂时保留健康 owner，
根 Run 完成不会抢走它的生产者。冷 Session 最终释放连接/资源，不永久占槽位。
故障、失联或提交未知时撤销旧授权/路由，再完成一次有序 Session writer 封口、
恢复检查点和 PG 关闭证明，才允许新租约。封口消息可幂等重试，不要求网络只发送一次。

删除逐子 Run seals 和依赖其数量的接管守卫，改为 Session writer 的关闭证明、
根工作收尾和必要的物理清理证据；不能直接把 unsealed_runs 清零当作已关闭。
聊天 Stop 仍走 Pi abort 和同序 operation cancellation；共享 VM 的其他进程不受牵连。
取消 ACK、租约失联或回包缺失仍不能证明物理进程停止，也不能释放 VM 配额。

## 8. Worker 直接写 Kafka

采用[原生 Kafka 研究](../reports/kafka-native-fencing-20261013.md)的候选：
每个活跃物理 Session 一个稳定事务生产者身份，所有 Conversation 共享。
事务 ID 关联 topic/tenant/physical Session，不包含 lease、epoch、Run 或 Worker boot；
这些业务身份仍在消息中验证。冷 Session 不占生产者。

- PG 原子领取/授权后初始化生产者；初始化完成后必须重新查询 PG 确认当前完整授权。
  每次重建都检查，不用旧缓存，不持有 PG 行锁等待 Kafka 网络调用。
- 普通写入由一个物理 writer 分配 native seq，保留完整 batch、图片引用和同批派发/
  展示信息，短 Kafka 事务 RF3 ACK 后才让 Pi 采用。没有每次提交查 PG。
- 控制面保留绑定等控制记录的发布。数据/控制同 Session 分区，但不同生产者之间
  必须用确认与同步撤销建立因果顺序；同 key 本身不保证跨生产者业务先后。
- 整 writer 故障关闭，控制方在 PG 撤销资格后临时接管同一事务 ID，初始化后再
  核实关闭意图/当前归属，提交 Session seal。已关闭则复用证据，不反复抢占新 owner。
  控制发布仍由 Projector 分区归属及 Kafka 原生消费组/事务机制隔离旧控制面。
- ACK 不确定、producer 被隔离或本地 ACK 后采用失败时冻结整个 writer，
  经有序关闭恢复同一个根 Run；不自动重发原生 batch 或未知 Shell。
  同 producer 的探针提交失败也冻结其传输；既有 Worker 心跳循环检查本地 producer
  失败状态并中断该 Session，避免纯等待模型时一直续租一个已经被 Kafka fence 的 owner。
  这不增加数据库心跳或将缺失沙箱探针当作销毁授权。
  保留封口位置校验，合法旧历史不能因为当前 epoch 更高就被全部丢弃。

研究已证明：失效 Worker 迟到初始化，可能先隔离当前合法生产者，再被 PG 拒绝。
初始化后检查防止其继续业务写入，但不能消除已经造成的可用性干扰。
这必须有有界恢复/退出及故障测试，不能用无限重连争抢或宣称 Kafka 理解 PG fencing。
真实租约、关闭、接管竞态未通过前不切换。旧控制方迟到初始化也适用同样约束。

删除 Worker open/append HTTP 中转、入口身份缓存/地址重定向及相关 Worker readiness
依赖；控制面自身的控制发布能力保留。PG 入场核实、租约观察、Tool 目标 fencing
和必要生命周期检查不是兼容代码，不能一起删除。
现有 runs.output_publication 还参与领取 COMMIT 不确定时的核对，须先替换该职责，
不能因名字像旧入口字段就删除。

生产者资源从按分区主要计数转成按活跃 Session 计数。做同负载 A/B：
线程、FD、RSS、事务/HTTP/SQL 次数、p50/p95/p99 和恢复次数，不能预先声称更快。
保持本地覆盖层和传输背压；控制面停顿导致投影不足时可等待，不能无限增长内存。

## 9. 改动范围与删除清单

| 区域 | 主要改动 |
| --- | --- |
| runtime-core / supervisor-host | 根 Run 领取、Session 持有、单 family Harness 生命周期；删除子 Run 调度；改取消/完成/恢复和模型许可绑定 |
| sandbox-supervisor / pi-session-postgres | 原生 Conversation 管理、工作关联、状态解释、统一代理和同批派发；保留完整公共 Storage 合同 |
| subagent-control / control-plane | 从有效执行意图处理 delegation/消息/监督需求；删 start→wait 往返、子 Run 再领取和独立完成状态机 |
| protocol / event-log | PiCloud 派发/回复、工作完成及 Session 关闭协议；同一 Worker mailbox；Session 事务生产者 |
| sandbox-control / Cube 边界 | 绑定改按 Conversation/compute scope 定位；operation 取消不扩大；保留 Cube 执行、物理清理和 Volume 权威 |
| database / Web / API | 根 Run 约束、旧子 Run/命令状态退出、派生查询索引；子对话树、输入、取消、SSE/历史/附件保持可定位 |
| Helm / release / docs | 匹配 schema/topic/协议版本、迁移守卫、残留清理；区分首次切换与后续兼容控制面更新 |

不删除运行中的独立 compute 资源记录，不把子 Conversation 变成新的 Worker 槽位，
不保留新旧工具/发布双模式。原生工具注册仍在 Worker，控制面从不运行 Pi Harness。

## 10. 分阶段实施与验收

一次只做一个完整切片，先隔离验证。阶段间可以保留尚未迁移的唯一旧路径，
最终发布不得有双写/兼容 fallback；所有产品能力迁完才进行本次匹配上线。

| 阶段 | 工作与退出条件 | Backlog |
| --- | --- | --- |
| P0 | 建立不依赖子 Run 的原生创建/输入/等待/阻塞/取消/恢复原型，冻结身份和完成语义；证明所有现有 subagent 动作可表达 | R13S-01 |
| P1 | 同批工具派发、可信处理器与通用代理、统一 Kafka 最终回包；混合效果/offset、乱序与重复回复通过 | R13T-01 |
| P2 | 根 Run 承担整份工作，子 Conversation 直接由 Harness 管理；迁出旧子 Run、命令表和所有模型/工具/展示/资源依赖 | R13S-02 |
| P3 | 根工作有序完成与 Session writer 封口分离；无逐子 Run seal，接管不再依赖已移除的子 Run 收尾 | R13K-02 |
| P4 | 接入 Session 原生事务生产者、控制发布与故障恢复，删除 Worker 入口；真实 Kafka/PG 故障与资源 A/B 通过 | R13K-01 |
| P5 | 完整破坏式匹配切换和 live 验收；随后验证兼容控制面更新不要求整份工作结束 | R13U-01 |

必须新增/更新的关键验收：

1. 主 Agent + 两个普通子 Agent + 孙 Agent：只有一个根 Run/Session 租约/writer；
   原生状态完整、配置正确、并行模型许可公平，等待不占许可。
2. 子创建前后、输入确认前后、回包 ACK 前后崩溃/重复通知：不重复创建或消费；
   参数不同但身份相同必须冲突，不能覆盖原任务。
3. 主 final 先于子结束、父子监督请求、末尾 follow-up 竞争、单子取消与根 Stop：
   原生 idle 与输入收尾准确，兄弟继续，完成覆盖不丢不重复。
4. 控制面单独替换后继续派发/回包；Worker 丢失后恢复同根 Run 和多 Conversation，
   队列/图片/Compaction 保持，unsafe Tools 和 workflow 不自动重跑。
5. 原生提交混有控制操作和 Bash：投影故障、rebalance、offset ACK 丢失和只读重建，
   控制效果可恢复，任意 Shell 不因回放重复派发。
6. shared/ephemeral、不同 cwd、子工具限制和纯聊天：绑定不串，普通 Tool 失败/
   单子取消不清理共享 VM，清理仍需 recorded-node 的物理证据。
7. 回包重复、错误来源/boot、晚于取消、一小时等待、附件解码失败：Pi 的终态不被
   覆盖，控制面不冒充 Cube 证据，回复不成为第二份长期历史。
8. 旧 Worker/旧控制方停在 init 前后、PG 核实前后、produce/commit ACK 前后；
   新 owner、关闭重试及未知提交交错，禁止旧业务发布/重复清理/无限 producer 互踢。
9. 浏览器子任务树、历史/导出、follow-up/steer 编辑和 Stop 返回草稿、预览、图片、
   workflow/supervisor 全部保留；只读恢复/索引重建不执行任何效果。
10. 持续活动根 Run 中兼容替换控制面：流式文本、子 Agent、Cube 长工具和图片均覆盖。
    允许有界重连/背压，不能因正常更新丢输入或将 Run 判为失败；实际暂停时间须测量。

每阶段运行相应 Pi 合同、PG/RF3 Kafka 集成与故障用例。最终执行仓库维护的 CI、
transport/fault、打包和匹配发布检查，并用 GPT-6 Luna 做真实 Cube/浏览器验收。
现有八项 Harness 测试、六个 Kafka 原语实验和两项入口测试仅为基线，不代表以上通过。
实际 source/live 验证与边界见[实施记录](../reports/session-work-implementation-20261013.md)。

## 11. 切换、风险与采用证据

首次改造是协议/存储匹配升级，不能用它承诺首次零停机：
冻结接纳，排空/关闭旧 writer，确认物理清理，再处理旧业务记录和匹配部署。
按已授权开发阶段策略清理旧子 Run/命令/Topic/协议残留，不做旧版本兼容。
保留账户、模型/Provider 配置、凭据；不能先删不确定物理资源的归属记录。
精确迁移版本在实现时由当前 schema/topic 决定，不在方案里预占版本号。
故障回退使用排空后的匹配版本恢复/重部署，不让旧二进制直接读写新协议。

后续仅控制面接口/内部重构、Worker/Pi/Cube/协议不变的更新，验证后可以有界交接，
不再等长 Agent 自然结束。Worker 自身无损升级、跨 Worker team、跨节点 HA、
任意 schema 零停机和 Cube 外部副作用 exactly-once 不属于本次承诺。

采用已有原生能力，避免引入第二个运行时：

- Pi Durable 1.0.0（MIT）：公开 Harness/Conversation/Task/Storage 和 tools 接口；
  [迁移证据](0229-native-durable-runtime.md)、[存储研究](../reports/append-only-storage-review-20261011.md)
  及源码合同已经核对。新增代码限于云端边界/协议适配，不复制 agent loop。
- Apache Kafka（Apache-2.0）、固定 Confluent JavaScript 1.10.1（MIT）：
  [原生事务/fencing 研究与真实实验](../reports/kafka-native-fencing-20261013.md)
  包含官方接口、版本/许可证和失败语义；不 fork broker、不增加 broker/消费组租约。
- PostgreSQL：沿用当前事务、唯一身份、Session 租约和根工作入口；不添加第二套
  调度器、工具执行账本或持久化大回复队列。研究过的事件存储/工作流项目不能与 Pi
  同时成为执行进度权威，本次不引入 Temporal、Marten 等新服务。

P0 若无法在公开 Pi API 下保持现有语义，或 P4 无法闭合授权/关闭和有界恢复，
记录具体失败与最小方案修订；不能绕过验收偷偷保留子 Run 调度、改 Pi 私有循环、
增加 RunAttempt，或降低写入/物理清理的保护。

## 14. 滚动交接验收发现的 Reader 暂停状态（2026-10-14）

3491d44e 的真实滚动替换中，Worker 已将工具结果、最终文本和 work_finished
提交到 Kafka，但 Projector 保留的分区没有继续消费。该 Run 经单实例重启完成
投影，未重跑工具。此前顺序退出/重启的传输测试没有覆盖重叠成员的这条路径。

隔离 RF3 测试复现：B 处理分区 1 并暂停拉取时，A 离组；B 重新获得分区 1，
同时获得分区 0。librdkafka 保留分区 1 的暂停状态，旧处理器因 generation
已改变而正确地拒绝 resume，于是只消费分区 0。安装新 assignment 时显式
resume 新分配的分区，随后仍由恢复逻辑暂停确实不可用的分区。它不改变
commit offset、原生序号、Tool 派发或 fencing 权威。新测试纳入完整传输套件。

## 15. 控制工具恢复与重放必须使用相同的引用表示（2026-10-14）

6ba81a94 的真实子 Agent 滚动验收发现：恢复扫描保存 cloud_metadata 中的引用，
正常 consume 却保存附有 arguments/nativeCallId 的展开命令。同一原生调用重放时，
引用与命令被身份比较误判为冲突，使分区无法推进。普通恢复测试没有重放该意图，
因此漏掉了这个组合。新增测试先恢复等待中的调用，再重复消费原生意图，修复前
明确复现 Control dispatch identity changed；真正的 replyTopic 变化仍须拒绝。

consume 保留原生意图校验，但内存中只保存原始派发引用，与恢复扫描保持一致；
实际执行时仍由 #load 从原生日志解析参数。不删除身份检查，不跳过 Kafka 记录，
不改变 offset 或重放任意工具。该修复不变更存储/协议，可以使用已扫描的新控制面
镜像替换故障实例以解除停滞，再完成匹配发布；原 Worker/Cube 的身份和取消结果保留。
