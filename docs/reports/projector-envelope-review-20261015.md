# Projector 消息体与解析链路审查

日期：2026-10-15。源码基线：`c3aca045`，当前架构 ADR-0243/0244/0245/0247/0248。
本次是审查，未修改产品运行代码、消息协议、数据库或线上部署。
复现脚本只使用合成输入、独立 PGlite 和当前源码，不读取用户会话。

结论：保留一组 Session Projector、Worker 直写 Kafka、PG 控制权威、先确认派发
offset 再交给 Cube 的边界。精简重点是 PiCloud 信封、派生展示和重复解析，不能
通过删减 Pi 原生 Storage batch、取消 fencing 或把工具执行搬进 Projector 达成。

## 范围与证据

追踪了 Worker 的 `DurableRemoteTools`、Session Storage 发布准备、
`DurableSessionPublisher`、`WorkerExecutionLog`、直写授权适配器，Kafka 解码和
分区处理，原生 PG 投影、实时视图、控制工具恢复、Cube/workflow 派发及固定 guest
工具的字段读取。对照了固定 Pi 1.0 的事件翻译和公开存储语义。

15 个现有测试文件、89 项测试全部通过，包含发布身份、取消、文本引用、封口、
重放、Projector 交接、控制工具恢复和生产者隔离的源码契约。
这不是一次新的真实 Kafka/Cube/模型或线上故障验收。
完整命令和测量值见 [JSON 证据](projector-envelope-review-20261015.json)。

另外执行了三个基线复现：

```bash
node --import tsx scripts/experiments/review-20261015/envelope.mts
env -u PI_CLOUD_POSTGRES_INTEGRATION_URL node --import tsx scripts/experiments/review-20261015/prefix.mts
node --import tsx scripts/experiments/review-20261015/display.mts
```

脚本会向 `/tmp/pi-cloud-projector-*-review-20261015.json` 输出合成测量结果。
它们刻画本次基线；修复对应问题后，应更新断言或转成正式回归测试。
内存复现通过临时观察 `Map.set` 取得真实前缀 Map，未修改运行源码；计数是逻辑
保留文本字节，不能直接当成 V8 RSS 或内存翻倍的测量。

## R15P-01：内部文字前缀职责过重，强制封口还遗漏子对话清理（P2）

位置：[execution-stream-projection.ts](../../packages/runtime-core/src/execution-stream-projection.ts)
的 `#prefixes`、`project()` 两处 `execution_seal` 分支、`#handoffViews()`；对照
[session-live-view.ts](../../packages/runtime-core/src/session-live-view.ts)。

`ExecutionStreamProjector` 为每个 Writer/Run/对话保存 `CompactEventTail`，包含完整
展示文字、事件序号去重表及字符串合并逻辑。但其下游只使用前缀是否存在、最高
展示序号，未读取这份前缀的文字。网页使用的是 `SessionLiveView` 里的另一份尾部。
这会重复管理和合并文本，且实际监控的 live-tail 字节没有包含这份私有缓冲。

还有一个已经复现的生命周期问题：正常 `work_finished` 会清理该 Writer 的全部
前缀；强制 `execution_seal` 的两处分支只删除根对话的 key。旧 Writer 释放后，
子对话的缓冲仍在 Map 中，直到分区重置/进程重启才清空。

复现使用真实原生投影、真实子对话关联和 PGlite 封口事务：

| 时点 | 内部前缀数 | 内部保留文字 |
| --- | ---: | ---: |
| 子对话两段文字投影后 | 2（根＋子） | 262,144 字节 |
| 封口 offset=20、PG 确认 Writer 已释放 | 1（子） | 262,144 字节 |
| Projector reset 后 | 0 | 0 |

同一复现中，公开 live view 也管理着 262,144 字节文字。这证明存在两份文本视图，
不证明底层字符串内存没有共享。

建议：把这份内部结构缩成“已观察到前缀＋最高展示序号”，由公开 live view 保留
展示正文；统一按 Writer 清理根和子对话。必须保留封口缺失前缀检测、交接时推进
所有子对话序号、去重/冲突检查和公开视图的恢复语义，不能直接删掉整个 Map。
验收增加“多子对话输出中强制封口后旧 Writer 状态全部释放”和“恢复序号不回退”。

## O15P-01：工具展示仍重复发布原生参数和结果正文（P2，效率问题）

位置：[durable/run-events.ts](../../packages/sandbox-supervisor/src/durable/run-events.ts)
的 `tool_execution_start/end` 分支，以及
[pi-cloud-turn-runner.ts](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts)
的 `emit()`/原生事件监听。

同一 `durable_commit` 内，执行参数确实只存一份：`tools[]` 引用原生 Task。
但在原生提交采用后，事件监听还会发布新的 `agent_event`：

- `tool.started.payload.input` 再复制完整参数。
- `tool.completed.payload.output` 再复制截断后的结果文本，默认展示上限 65,536 字节。
- `user.input` 也保留了独立展示正文；这不是本次先行精简的必要范围。

合成适配器复现：80,000 字节的 write 参数在额外 `tool.started` 中再次出现，整条
展示消息 80,794 字节；16,384 字节的工具结果又形成 17,153 字节展示消息。
这不等于原生 Tool Result 重复落 PG，而是 Kafka 和展示缓冲重复携带正文，且增加
独立发布/处理工作。ADR-0245 当时明确只覆盖 assistant text，所以这是未覆盖的
优化机会，不是声称当时已实现了全部事件去重。

建议：延续同提交展示引用的方式，让可信 Worker 在提交准备阶段生成工具展示描述，
Projector 从该批原生 Task/Entry 构造现有公开事件。参数校验、Pi hook 和最终结果
仍由 Worker/Pi 决定；不能从 Cube 原始回包提前生成正式结果，也不能让 Projector
运行 Harness。原生 watcher 是提交后的回调，不能让 Storage 等自己的回调来补齐
同一提交。只改明确重复正文的事件，不一刀切删除全部 `agent_event`。

验收需覆盖完整工具意图后才显示执行、原生取消/UNKNOWN、after-hook 改写结果、
超大 write/read、多子对话、重放及展示覆盖，不新增 PG 正文查询或第二个事件消费者。

## O15P-02：解码时构造派发对象，丢弃后又构造一次（P2，效率问题）

位置：[kafka-accepted-fact.ts](../../packages/runtime-core/src/kafka-accepted-fact.ts)、
[tool-invocation-fact.ts](../../packages/runtime-core/src/tool-invocation-fact.ts)、
[session-projector.ts](../../packages/runtime-core/src/session-projector.ts)、
[control-tool-dispatcher.ts](../../packages/control-plane/src/control-tool-dispatcher.ts)。

一次 Cube 工具消息在 Projector 中会经历：

1. 解码循环调用 `durableToolIntent()`，线性寻找 Task。
2. 解码又调用 `toolCommandsForFact()`，再次查找、校验并构造请求，然后丢弃结果。
3. 派发阶段再次调用同一函数，再查找和构造。

控制工具也在解码和 dispatcher 中重复展开。Worker 的最终发布校验同样存在重复
查找，但 Worker 和 Projector 分别在自己的边界校验并非天然多余。

在 100 个 Task、100 个工具的合成批次中，仅 Projector 解码＋展开就执行 300 次
`find`、15,150 次元素判断；Worker 的 `assertSessionPublication` 另做相同数量。
这是查找次数的测量，不是吞吐或 p99 延迟结论。现有 projection timing 在解码之后
才开始，也不能用它排除解析阶段的成本。

建议：每个进程边界校验一次 PiCloud 信封，并为当前批建立临时查找结构；返回
已验证的派发描述/引用供后续使用，不重复构造和丢弃对象。不要做跨消息权限缓存，
也不要为了省查找给每个工具增加一次 PG 查询。Pi 允许批内顺序写入，索引设计
必须保留同一记录多次写入的语义，不得改写/重排 native batch。

## O15P-03：云端信封重复携带同一个事实（P3，协议精简）

位置：[durable-session-publisher.ts](../../packages/runtime-core/src/durable-session-publisher.ts)、
[accepted-fact.ts](../../packages/runtime-core/src/accepted-fact.ts)、
[tool-command.ts](../../packages/protocol/src/tool-command.ts)。

现在一个根 Run 的所有子对话共享物理 Session、Writer、租约代次和 Worker Boot。
这些信息在顶层、每条工具、每个取消、每组展示中反复出现；每个嵌套对象并没有
因此获得独立授权。

| 字段/信息 | 建议 | 原因和约束 |
| --- | --- | --- |
| 嵌套 scope 中的 tenantId / piSessionId / runId / writerId / fencingToken | 从本条消息顶层继承 | ADR-0247 要求它们一致；不用再次查 PG |
| 嵌套 sessionId / turnId | 保留对话定位，可收为 `view` | 子对话不同于根对话，绝不能全部替换成顶层值 |
| Cube 工具 scope.leaseId | 删去别名，适配时用 writerId | 发布器明确赋值 `leaseId = writerId`；workflow 消费者改用同一来源 |
| Cube 工具 factId | 删去副本，需要时从 operationId 构造内部对象 | 当前等于 request.operationId；顶层 factId 不能因此一起删 |
| Cube 工具 toolCallId=`task:N` | 从 taskId 派生 | 这是展示身份，不能与模型提供的原生 callId 混淆 |
| tools[].nativeToolName | 从 Kafka 派发描述删除 | 仅 Worker 的准备校验读取；保留 Worker 本地 Candidate 字段，尤其 workflow 的逻辑工具名 |
| 每条工具 replyTopic | 提升为本条提交的共同字段 | 同一 Writer/Boot 共用回包目标；不能在恢复时改成“当前 Worker”的 Topic |
| 嵌入 cancellations 的 kind/factId/occurredAt | 退休独立取消发布路径后可收窄 | 取消本身保留 activationId、operationId 和对话定位；其有序位置来自外层提交 |
| `closesWriter: true`、`retireWriter: true` | 可由消息 kind 表达 | 移除常量不等于移除封口证明、排空或 PG 释放条件 |
| request.type / toolBrokerProtocolVersion 固定值 | 可留在 Cube 适配器/guest 协议边界构造 | 不必在每条 Kafka 工具描述重复运输；实际 guest 协议仍需明确版本 |
| display 中重复的公共事件身份 | 可继承所在 view 并在 SSE 边界展开 | 保留事件稳定身份、序号、messageId、phase、replace 和 settledMessageId 的语义 |
| origins | 先保留，最多按相同来源分组编码 | 来源用于原生记录归属、历史/导航和 Fork；不能一律当成当前根 Run |

当前别名还制造了可分叉状态：单独修改工具 `leaseId`、`factId` 或 `toolCallId` 后，
现有解析器和 `assertSessionPublication` 仍接受。正常发布器会生成一致值，所以这
不是已证明的线上身份绕过；但没有必要维护两个可矛盾的表示。优先删除副本，
不要再加三套一致性补丁。改变嵌套 fencingToken 时 Worker 发布校验会拒绝，保留
这一事实；本次没有发现它可以绕过已有 Kafka 生产者隔离。

只对 Cube 描述做“公共身份继承＋去别名＋回包 Topic 提升”，保持原生 commit、
origins、时间戳和执行参数不变，得到以下序列化草图测量：

| 合成样本 | 当前消息 | 草图消息 | 减少 |
| --- | ---: | ---: | ---: |
| 1 个短 bash | 2,081 B | 1,744 B | 16.2% |
| 10 个短 bash | 16,021 B | 12,350 B | 22.9% |
| 100 个短 bash | 155,718 B | 118,653 B | 23.8% |
| 1 个含 360,000 B 正文的 write | 362,093 B | 361,756 B | 0.09% |

草图不是已实现协议。这说明信封精简主要改善小消息和代码一致性；大正文的重复
应优先处理 O15P-01，不能宣传省掉几个 UUID 就能解决大回包成本。

控制工具描述还会进入 `pi_durable_commits.cloud_metadata` 供恢复读取。若顶层信息
不再重复，落 PG 时必须保留完整、可恢复的共同上下文或确定性展开，不能依赖已经
删除的 Kafka 正文，也不能恢复时猜测 Worker Boot。

## O15P-04：固定工具还携带 workflow 才真正使用的上下文字段（P3）

位置：[tool-sandbox.ts](../../packages/protocol/src/tool-sandbox.ts) 的公共
`OperationEnvelope`；对照
[tool-command-dispatcher.ts](../../packages/sandbox-control/src/tool-command-dispatcher.ts)、
[envd-tool-exec.ts](../../packages/tool-sandbox/src/envd-tool-exec.ts)、
[native-tools.ts](../../packages/tool-sandbox/src/native-tools.ts) 和
[sandbox-controller.ts](../../packages/sandbox-control/src/sandbox-controller.ts) 的
`executeWorkflow()`。

固定 read/write/edit/bash 的路径现在直接交给 Cube。请求仍携带
`turnContextSha256`、`executionContextSha256`、`stepContextSequence`、
`stepContextSha256`，但在该路径中没有逐项比较它们与当前环境：guest 只做格式
检查，实际执行使用 binding 对应的初始化信息；Cube 独立检查 boot、writer 和
有序执行位置。整个请求的重复提交指纹会包含这些字段，不等于它们各自承担了
上下文授权。

workflow 路径不同：`executeWorkflow()` 仍明确比较这些 hash 和 Step 顺序，
不能从公共 schema 一刀切删除。

建议：在新的匹配协议中拆清固定工具请求与 workflow 请求，固定工具只保留实际
用到的参数、binding/operation 身份、超时和输出预算，以及已有 Cube 外部执行
fencing。workflow 暂时保留当前上下文检查。不得填虚构 hash 做兼容，也不得把
任意工具执行改成逐次 PG 查租约。该项需要单独记录协议决策并做 guest 合同验收。

## C15P-01：取消旁路、派生类型和旧多 Run 脚手架可删除/收窄（P3）

- 正式 Durable 取消由 `DurableRemoteTools.preparePublication()` 进入
  `durable_commit.cancellations`。仓库中没有生产调用者调用独立
  `publishToolCancellation()`；Worker 接口、候选 Fact、独立解析和 Projector
  分支仍保留。可以一起退休这条无调用旁路，保留原生 abort 与取消同提交，保留
  重放取消的幂等性及异常 binding 清理。
- `AcceptedFact` 把 Kafka 线上消息和展开后的 `tool_command` 混在一个 union。
  实际解码器不接受独立 `tool_command`，Worker 也禁止发布它；它仍是派发端需要的
  内部命令。拆清 wire fact 和内部命令，删除不可到达的 wire 分支，不删除 Cube
  适配器的命令类型。
- `PostgresDurableCommitProjector` 仍收集/排序多个 Run ID、聚合成 JSON、转回 Map，
  然后遍历单元素 `[fact.scope]`。当前有效批次只对应一个根 Run；子对话需要的是
  Conversation/view 验证。可以缩成一次根 Run 校验及其子视图校验，但必须保留
  Run→lease→native Session 的锁顺序和事务时的封口检查；不能直接删 SQL 锁。
- 无工具的普通提交仍调用 Tool dispatcher，随后被它作为 ignored 返回。
  `nativeChanges` 实际承担队列视图通知，却计时为 `subagent_route`。这两项属于
  小范围职责/命名清理，不需要拆出服务或改变消费组。

## 必须保留的信息和边界

| 内容 | 必须保留的原因 |
| --- | --- |
| 原生 commit.seq / nextId / writes，Task 状态、version、owner、abortRequested、checkpoint、replay 等 | Pi 原生存储与恢复语义；Kafka offset 不能替代，不能为了省字节过滤原生 batch |
| 顶层 tenantId / piSessionId / runId / writerId / fencingToken | 租户、物理存储、逻辑工作和租约代次不同；Kafka 的 producer epoch 不替代 PG 授权或外部工具 fencing |
| 每个子对话的定位和来源 | 同一个 Writer 内也有不同的对话、Workspace 和展示序号 |
| 原生 callId、taskId、operationId | 分别对应模型调用关联、原生任务、远端操作/取消/回包；只能去掉可推导的别名，不能合成一个 ID |
| activationId/bindingId 与原始 Boot 回包地址 | 同一个 Session 可有不同执行环境；迟到回包不能发给接替 Worker |
| 原生记录 provenance、展示序号与 coveredThrough、work_finished 的 nativeSequence/baseSequence | 历史归属、实时/历史合并、交接和去重 |
| 原生 after-hook 后的结果及图片引用 | 正式 Tool Result 由 Pi 确定；图片像素不因精简信封而重新进入 Kafka |
| 发生时间和观察身份 | 旧记录重放不能被误认为新心跳；工具准备时间和提交时间也不一定相同，不能机械合并 occurredAt |
| 控制变更的实体版本、闭合状态、不可变 cancelTarget | 支持最新内存视图和原地址故障清理；Kafka 顺序不能推导消失的物理目标 |
| inputQueueSessions 提示 | 让队列视图只在相关提交时刷新；删除它后不能恢复每条日志查队列或轮询 |
| dispatch commit、重放下界、原生投影进度 | 三者边界不同；重建文字不能重新执行 Shell |

现有顺序保持：PG 原生投影成功 → 公开视图/可恢复控制引用 → 确认派发 offset →
请求 Cube 接管。消费位置提交与 Cube 接管之间的 UNKNOWN 窗口仍是已记录的取舍，
本次没有把它重新包装成新发现，也不建议用自动重放任意 Shell 来掩盖。

## 建议实施顺序

1. 先修 R15P-01，缩小内部前缀状态并统一 Writer 清理；不改协议。
2. 收敛 O15P-02 的解码结果与批内查找，保持所有边界检查；不引入缓存权威。
3. 记录一份精简 PiCloud 信封的 ADR，处理 O15P-03 和 C15P-01 的协议部分，
   一次匹配切换，删除旧格式，不保留双模式。
4. 单独处理工具展示同提交引用，再单独处理固定工具/guest 请求精简。

每项完成后验证原生提交完整性、子对话定位、取消、重放、封口和真实工具回包，
再走维护的匹配发布流程。不能把字节测量草图当成已经通过的协议迁移。

本次同时校正文档中两处旧描述：流式 pi.live 并非每次增量落 PG；子对话共享
根 Run，不拥有独立 Run。阅读进度停在 Kafka→Projector，尚未展开 Cube 接管细节。
