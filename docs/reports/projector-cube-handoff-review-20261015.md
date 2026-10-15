# Projector → Cube 接管审查

日期：2026-10-15。源码基线 `93635d37`；对应运行版本
`projector-compact-bf55d9bd`，schema 189 / execution Topic v17 / guest 5 / Cube management 7。
这是审查记录，没有修改运行代码、消息协议、数据库或线上部署。

后续批准的[修复记录](projector-cube-handoff-repair-20261015.md)单独跟踪实施与上线。
下列审查探针已由维护中的回归测试替代；复现原行为须检出 `9097ba11`。

建议保留已认可的顺序：投影原生意图 → 确认单调派发 offset → 向 Cube 请求接管。
发现三个可复现的实现问题、一个查找优化点，以及一个尚未由当前原生调用触发的
批内位置契约隐患。无需增加 Broker、工具任务表、每工具 PG 租约查询或新队列。

## 范围与验证

追踪 `SessionProjector`、Kafka reader 的进度/分区交接、绑定内存视图、
`ToolCommandDispatcher`、Cube HTTP client，以及构建清单固定的 Cube API、
Master 路由和 Cubelet 接单管理器。Cube 源码由固定上游提交导出后依序应用
六个已校验 SHA256 的维护补丁，未读取操作者检出的未提交改动。
同时对照固定 Pi Durable 1.0.0 的 Tool intent 提交方式。

实际调用比前一段口头说明多一层原生路由：

```text
Projector → Cube API → CubeMaster → Cubelet 接单管理器
             HTTP       HTTP         gRPC
```

CubeMaster 根据记录的 nodeID 查自己的节点视图，再转发接单请求。
接单 ACK 不证明工具开始、完成或物理进程停止；最终结果仍走原 Worker 的 Kafka
回包通道。任意 Shell 副作用与 Kafka offset 不可原子提交，已认可的 UNKNOWN
窗口不是本次缺陷。

验证结果：

- 10 个现有 TypeScript 测试文件、99 项测试通过，覆盖派发/重放/分区交接、
  绑定闭合、HTTP 回执、失败分类和 mailbox 身份。
- 固定补丁的 16 项 Go admission 测试通过，启用 race detector。
- 两项新增隔离 Go 探针复现批内位置和删除后迟到接单行为，也通过 race detector。
- 真实本地 HTTP 探针先发 200 响应头再停止正文：接管请求约 5 秒结束，
  只发一次请求，证实超时覆盖正文读取，未发现“收到响应头就失去超时保护”。
- 原生 Pi Harness + faux 模型产生两个 read 调用，实际形成 seq 9、10 两次
  独立意图提交，每批一个工具；不使用真实模型或线上 VM。

本次没有重新进行真实 Kafka 集群故障或生产 Cube 故障注入。上述结果不应写成
一次新的端到端线上验收。完整机器可读结果见
[证据](projector-cube-handoff-review-20261015.json)。

一轮 HTTP 探针在退出前未完成，被终止；随后加强测试服务器/连接的关闭顺序，
增加独立 watchdog，并分别记录请求结束与清理时间，重跑通过。该次未完成的
夹具运行不计为产品超时缺陷，也不计为通过的验收。

## R15H-01：隔离失败会阻止接管失败回包（P2）

位置：[tool-command-dispatcher.ts](../../packages/sandbox-control/src/tool-command-dispatcher.ts)
第 164–189 行；隔离组合在
[sandbox-control-runtime.ts](../../packages/sandbox-control/src/sandbox-control-runtime.ts)
第 259–273 行。

收到 `executor_replaced` 或 `runtime_quarantined` 后，dispatcher 先等待
`quarantine()`，然后才调用 `#fail()`。隔离需要 PG 状态、控制面本地处理和
绑定变更发布；其中任一部分失败都会抛错，后面的失败回包不会执行。

例如 Cube 已明确报告“执行器换代”，但隔离变更发布暂时失败。此时工具调用已经
越过派发 offset；重放会跳过该工具，不能指望重放补发这个失败通知。
Worker 会继续等待，可能直到现有固定工具回包等待上限约七分钟才收尾。
隔离若迟迟不返回，也会延长该分区的处理等待。

探针使用真实 dispatcher，令 submit 返回 `executor_replaced`、quarantine 抛错：
submit 调用一次，失败回包零次，隔离异常向外传播。没有重跑工具或销毁 VM。

改善方向：接管失败通知与资源隔离分别收尾。隔离失败不能遮蔽已知的工具失败，
也不能阻止尝试通知原 Worker；资源隔离继续由既有控制面生命周期与控制变更
恢复机制追踪。需要覆盖隔离成功、失败、迟迟不返回和回包自身失败，保留
关闭路由、物理清理与派发不重放的要求。

## R15H-02：拒绝原因与执行证据混为一谈（P2）

位置：同一 dispatcher 第 168–190、268–274 行；
[Cube 补丁](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch)
中的 `handleManagedExecution`、`SubmitTool`。

CubeMaster 的 `node_unavailable` 分支明确发生在任何执行 RPC 之前；本地
`execution_endpoint_unconfigured` 甚至尚未发送 HTTP。但 dispatcher 将它们
映射为 `cubesandbox_tool_unavailable` 后，又按错误码默认设置 `effect: unknown`。

| 输入拒绝原因 | 当前回给 Worker 的 effect | 可证明的事实 |
| --- | --- | --- |
| node_unavailable | unknown | Master 未向执行端发送本次请求 |
| execution_unavailable | unknown | Cubelet 在调用 Manager.Submit 前拒绝 |
| execution_endpoint_unconfigured | unknown | 客户端尚未发送请求 |
| capacity | not_started | 执行器未接纳本次操作 |
| 未识别的拒绝码（合成探针） | not_started | 客户端没有定义这种拒绝的证据语义 |

前三种已知拒绝的确定未执行证据被丢失；兜底又反过来把未知拒绝当成确定
未开始。当前固定 Cube 版本没有探针所造的未知拒绝码，不将该兜底描述成已发生的
线上故障。由于 Worker 用 effect 决定取消证据、并配合 code 决定能否继续采样，
这不只是报错文案差异。

改善方向：用显式映射分别表达“基础设施是否可用”和“本次操作是否开始”。已知
前置拒绝保留 `not_started`，仍可通过 unavailable code 阻止继续采样；超时、
换代/位置冲突及未识别语义保守归为 UNKNOWN。对应消息应说明已确认的事实。
这不授权自动重新执行工具。

## R15H-03：删除后的迟到接单会重建已清理的 VM 顺序记录（P2）

位置：[Cube 补丁](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch)
中的 `Manager.Submit`（约 6012 行）、`Manager.ForgetRuntime`（约 6208 行）和
`service.SubmitTool`（约 7142 行）。

按节点确认 VM 不存在时，`ForgetRuntime` 删除其位置记录。然而 `SubmitTool`
直接进入 Manager；Manager 先登记 operation 和位置，之后才由 Driver 查找 VM。
因此，一个迟到请求可以在清理之后再次建立该已删除 VM 的位置记录。

隔离探针模拟“执行完 → 确认删除并 Forget → 迟到 Submit → Driver 发现 VM 不存在”：
迟到提交仍获接纳，操作结束后 active operation 为零，但位置 Map 从 0 重新变成 1。
Driver 不会重建 VM，也没有产生新文件/Shell 副作用。问题是接单证据和生命周期
不一致，以及不再被后续清理覆盖的历史状态；大量此类迟到工具请求可累积残留。
这不是“已删除 VM 被重新启动”的证据。

改善方向：将接单登记纳入当前 VM 的生命周期准入边界，使物理删除/忘记身份与
迟到接单互斥。单独在接单前查一次 VM 仍可能留下检查与登记之间的竞态，需要
加入对应交错测试。复用 Cube 的 VM 生命周期，不增加 PG 工具账本或永久历史墓碑。

## O15H-01：已有精确索引，工具定位仍枚举整个 Session family（P3）

位置：[sandbox-binding-view.ts](../../packages/sandbox-control/src/sandbox-binding-view.ts)
第 174–183 行，以及 dispatcher 的 `routes.find()` 后再按 activationId 查找。

内存表本来以 tenant + root Run + bindingId 为键；但 find(scope) 从 writer 索引
取出所有绑定，构造数组，再让调用者找其中一个。迁移为整个 family 共享 writer
后，成本随同一 family 的绑定数增加。

合成 1,000 个有效绑定，单次定位前的 find 进行 1,000 次条目读取并返回 1,000 条
路由；PG 读取为零。它没有增加数据库往返，但仍有可避免的线性遍历和分配。
这不是生产延迟或大规模容量测量。

改善方向：普通 Tool/取消按已有 bindingId 点查现有 Map，再验证租户、Run、writer
及关闭状态；需要枚举的生命周期接口保留枚举语义。无需另造缓存或权限权威。

## D15H-01：批内多个工具与 Cube 的 offset 契约尚未一致

PiCloud 的 `durable_commit.tools[]`、decoder 和 Projector 支持一批多个工具；
实际编码/解码探针也接受两条同批派发描述；同一 Kafka 消息展开出的工具共享
offset。Cube 的新 operation 则要求 offset
严格大于该 VM/分区上次位置。两个不同 operationId 在同一位置时，第二个会被
拒为 `execution_position_stale`；Go 探针已复现。

不过固定 Pi 1.0 的普通 ToolTask 会各自提交执行意图。本次真实原生 Harness 的
两个 read 也产生两次提交，因此没有证据证明普通并行 read 当前就会触发此问题。
它作为跨边界的契约隐患记录，不列为正在发生的生产故障。

若保留批内多个 Cube 效果的能力，需明确派发位置中的批内顺序/身份，并覆盖同批
多个操作、同批取消、旧位置重放与跨分区共享 VM；不能简单把严格比较改成允许
相等，否则已完成 operation 的重发也可能再次进入。需要协议决策时另写 ADR，
不修改 Pi 原生 batch 来适配云端限制。

## 保留的边界与建议顺序

保留先确认派发 offset 的行为、单一 Session Projector、PG 控制权威、绑定内存
视图、Cube boot/位置保护和原 Worker 回包目的地。接管 HTTP 超时确实覆盖完整
响应；工具执行时长不占用这条 HTTP 连接。失去回执不触发 Shell 重发，正常错误
不直接销毁共享 VM；现有这些约束无需推翻。

建议先修 R15H-01/02 的失败收尾，再修 R15H-03 的接单/删除边界；O15H-01 可作为
独立小优化。D15H-01 先明确实际批内效果能力，再决定协议改动范围。

复现命令（只用合成数据、隔离容器/本地 HTTP；不接触生产会话）：

以下命令针对 Git `9097ba11` 的完整检出，不针对已修复的当前分支。

```sh
node --import tsx scripts/experiments/review-20261015-handoff/routing.mts
node scripts/experiments/review-20261015-handoff/admission.mjs
node --import tsx scripts/experiments/review-20261015-handoff/native-commits.mts
```

探针刻画本次基线，断言已观察到的行为；修复后应更新为正式回归断言或归档到
本次 Git 基线，不能把它们原样当成永久正确性标准。
