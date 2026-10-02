# 全仓代码与架构审查 · 2026-10-02

审查基线：`6c74c653`；Pi 固定为 **0.84.1**。覆盖 22 个工作区、1,348 个受版本控制文件。
本次修改 README、维护文档和审查复现脚本；没有修改业务实现、生产数据库或部署。

结论：**保留 Pi Loop、PG 权威、Session writer、统一 Projector 和 Cube 执行边界。
目前更需要修正恢复边界和减少重复工作，而不是继续增加服务。**
确认 4 项实现问题，另列 5 组优化机会/扩展限制。最近的内存视图确实省掉了热点查询，
但它增加的 Outbox、Kafka、投影和重新读取成本尚未被完整计量；不能从“100 次查绑定零 SQL”
推导出“整个系统总 SQL 已下降”。

## 范围与方法

[清单与依赖覆盖](repository-review-20261002-coverage.json)记录了全部工作区。全仓覆盖采用
文件/依赖盘点、调用和定时任务扫描，再深入关键路径；并非声称每一行都获得形式化验证。
迁移区包含 162 个迁移及索引文件，旧迁移作为建库历史阅读，不作为当前拓扑。

| 范围 | 审查重点 |
| --- | --- |
| sandbox-supervisor、supervisor-host | 原生 Agent/hooks、采样/Compaction、模型 permit、消息消费、失败后停止、Worker 容量和启动 |
| runtime-core、event-log | 发布准入、Session 顺序、Kafka 事务与提交、封口、恢复位置、Outbox、SSE 和背压 |
| database、pi-session-postgres | PG 权威和时间、索引日志、冷恢复、Fork、当前操作引用、迁移/触发器副作用 |
| control-plane、subagent-control | 队列、Steer、子任务、投影失效、租户/树操作、Issue 协调、资源状态、就绪检查 |
| sandbox-control、tool-sandbox、workspace-runtime、cube-completion | 物理 VM、绑定、停止、探测、回包、Volume、固定 Guest 工具、托管执行补丁 |
| session-attachments | 不可变图片引用、编码/解码、PG/S3 边界、引用清理和容量 |
| cube-api-authorizer、cube-egress-gateway、provider-egress-relay、ssh-gateway | 认证/路由、连接终止、出站边界、临时票据和凭据隔离 |
| protocol、domain、web-ui | 协议版本、快照/SSE、消息队列、资源轮询、运行状态、公共/内部模型边界 |
| observability、fake-model-server、scripts、deploy、eval | 观测成本、夹具真实性、发布/镜像/Helm 合同、故障矩阵与文档一致性 |

核对当前 ADR，尤其是 0167、0180、0183、0187、0197–0201、0209–0212。
Pi 对照使用实际安装的 0.84.1 `Agent`、`agent-loop`、Session 和 Harness 实现。
该版本 `AgentHarness.prompt/resume/steer` 等仍返回 `HarnessNotImplemented`；
现有 `new Agent` 加公开 hooks/Compaction API 的选择有依据，不能直接建议换用尚未实现的高层 Harness。

[复现数据](repository-review-20261002-probes.json)明确区分真实隔离 PG 和模拟外部端口。
PG 使用当前完整迁移；发布阻塞、消费者不可用、VM 观察等使用受控端口。没有在生产上
制造 VM 故障或 Kafka 中断，也没有把这些结果当作吞吐量或多节点 HA 证明。

## 确认的问题

以下 P2 表示有明确触发条件的实现缺陷，需要修复；不表示已观察到生产数据丢失。

### R02-01 · P2 · VM 隔离状态的落库被 Kafka 发布确认挡住

位置：[sandbox-controller.ts](../../packages/sandbox-control/src/sandbox-controller.ts)
第 3093、3262 行；[sandbox-bindings.ts](../../packages/sandbox-control/src/sandbox-bindings.ts)
第 139–147 行。

健康监测已经获得明确的 stopped/absent/unsafe 证据后，两个隔离方法先等待
`bindings.closePhysical()`，然后才设置本地 failure 和 PG 资源的 `unknown`。
`closePhysical()` 同时承担了两件事：提交 PG 绑定关闭，以及等待控制引用发布。
后者失败就会提前退出，资源状态没有被保存。

使用真实 Monitor/Controller、模拟状态库和发布故障，得到：

| 相同的 VM stopped 观察 | 绑定 | 资源状态 | 删除 VM |
| --- | --- | --- | --- |
| 关闭发布成功 | closed | unknown | 否 |
| 绑定已关闭，但发布确认失败 | closed | **仍是 running** | 否 |

这不证明旧命令能绕过 Cube 的执行边界；它证明 **本应由 PG 决定的隔离状态，反而依赖
通知链路成功才能写下**。管理页面、后续资源准入和恢复会继续看到旧状态。
Tool dispatcher 的另一条 quarantine 路径已把资源状态和绑定一起写 PG，两个入口的语义不一致。

建议：先关闭本地准入，并在 PG 原子保存资源隔离和绑定关闭，再等待 owner 屏障和有序发布。
发布失败保留“已隔离、关闭待确认”，继续重试；不能改成默认成功，也不能释放配额。
验收应覆盖 VM 明确异常与 Kafka/owner 不可用同时发生，以及共享 VM 的全部绑定。

### R02-02 · P2 · 发布就绪检查可以在没有可用 owner 时返回 ready

位置：[session-projector.ts](../../packages/runtime-core/src/session-projector.ts)
第 331–349 行；[session-publication-service.ts](../../packages/control-plane/src/session-publication-service.ts)
第 43 行；[runtime.ts](../../packages/supervisor-host/src/runtime.ts)第 435 行。

`checkIngestHealth()` 只检查 start 标志和 topic 是否存在。消费者启动是后台过程；分区
分配、生产者安装或控制视图恢复尚未完成时，这个接口仍可返回 200。
Worker 的 Run claim readiness 使用该接口，而 Run 已完成 PG admission 后才打开发布 scope。

真实 Projector/HTTP 服务配合不可用的消费者端口：完整 `checkHealth()` 拒绝，
`/session-publication/health` 却返回 **200**，同一服务的 open 返回 **409 not_owner**。
客户端虽会重试，默认 15 秒后仍无 owner 就会失败；这种失败发生在 Run 已被接收执行之后。

建议区分监听就绪、可接受业务命令、可执行某分区的 Run。执行就绪应包含可用的发布 owner
及所需视图，而不是 topic 存在。不要机械调用全局 `checkHealth()`：投影积压、某个无关分区
失败和真正无法发布是不同状态，也不应把所有已运行 Session 一起停掉。

### R02-03 · P2 · Outbox 的整批等待扩大了故障影响范围

位置：[session-outbox-relay.ts](../../packages/runtime-core/src/session-outbox-relay.ts)
第 138、200 行。

一个 relay 领取 16 条记录，等待整批 `Promise.allSettled` 后才领取下一批。
因此一条慢关闭/慢 owner 发布会占住整个 relay 的继续处理，即使另外 15 条已经完成。

隔离 PG 中放入 20 个 Session，按实际 hash 对应 20 个不同分区；模拟其中一条发布等待。
结果始终只尝试前 **16** 条，后 **4** 个健康 Session 的记录要等它解除阻塞。
这不是 Kafka 要求的同分区顺序，而是额外的跨分区等待。其他 relay 副本可能缓解它，
但不能作为单实例和任意多慢目标情况下的隔离保证。

建议把现有 relay 改为有并发上限的持续处理：一个发送槽完成就允许补充下一条可领取记录，
保留 PG claim、重试期限和同实体前驱顺序。不需要再加任务系统或另一个 broker。

### R02-04 · P2 · Subagent 的无变化重放仍产生新的控制通知

位置：[subagent-controller.ts](../../packages/control-plane/src/subagent-controller.ts)
第 287–301 行；[迁移 162](../../packages/database/src/migrations/162_subagent_control_changes.ts)
第 23–39 行。

消费端用 `INSERT ... ON CONFLICT DO UPDATE SET id=id RETURNING` 读取已有命令。
但 BEFORE INSERT trigger 已先生成 revision 和 Outbox 引用。即使随后走无变化 UPDATE，
这个引用仍随事务提交。

真实 PG 复现：命令行 revision 完全不变，每重放一次仍新增 **1 条 Outbox 引用**。
这是通知副作用失去幂等性，未证明子任务被重复执行。
PostgreSQL 明确规定这种 upsert 可以先触发 BEFORE INSERT，再触发 BEFORE UPDATE；
不能只依赖 UPDATE 的 no-op 分支消除 INSERT 的副作用。
[官方触发器语义](https://www.postgresql.org/docs/current/trigger-definition.html)

建议将版本分配与实际变更后的通知分开，或改用不制造插入副作用的幂等读取路径。
已有命令的重放不应产生新的业务变化。保留身份复用冲突检查。

## 优化机会与扩展限制

### O02-01 · 对“读变成事件”计量整条链路，而不仅是缓存命中

当前证据：

| 工作 | 观察 |
| --- | --- |
| 一个无 Tool 的夹具 Run 接收、admission、完成 | 产生 **2＋3＋3＝8** 条同 Session 的 input_queue 引用 |
| 没有 held Steer 的 Session 做一次 reconcile | 仍执行 **2 次 SELECT** |
| 已知 Subagent 命令版本收到 5 次相同版本通知 | `changed()` 仍做 **5 次 selectAll** |

第一、二项使用真实 PG；第三项使用实际 Controller 和计数数据库端口。
调度可能合并唤醒，因此不能简单把 8×2 宣称为每轮实际查询次数。
这些结果足以说明：**热点读减少成立，但目前没有证明全链路数据库工作量的净变化。**

建议在同一事务内合并同实体的队列/状态失效引用；只唤醒确有待办的 Steer Session；
Subagent 对已安装或已退休的版本先做内存判断，再决定是否回读大行。
多个 API 副本的 Steer 全局 bootstrap 也值得收敛到已有分区 owner，保留 PG delivery guards。
绑定创建/撤销有同步执行屏障，不能和普通展示失效一起随意合并。

后续基准应分别统计一次完整 Turn 的 SQL 往返、Outbox 行数、Kafka bytes/transactions、
投影写入、恢复耗时和内存，而不是仅增加一条“getter 零 SQL”测试。

### O02-02 · Outbox 的空闲扫描与清理预算没有适应新的流量

默认 50ms fallback 使一个空闲 relay 在一秒内仍执行约 **19–20 次 SQL**。
这是 ADR-0177 继承的延迟取舍，不是数据库错误；现在 LISTEN 已实现，可以测量健康
通知连接下更长的空闲 fallback 和已知 retry deadline，而保留重连后的补扫。
PG 的 NOTIFY 在提交后送达，并合并同事务的相同通知；这种合并不会替我们合并 Outbox 行。
[官方 NOTIFY 语义](https://www.postgresql.org/docs/current/sql-notify.html)

清理目前每分钟最多删 512 条，且与发送共用同一个循环。单 relay 的名义清理上限约
8.53 条过时引用/秒，实际还可能更低；持续产生速度超过它时，分批删除不等于总量有界。
慢清理 SQL 本身也会暂停该 relay 的发送。

现有 `OperationalMetricsSampler` 只统计 terminal Outbox 待发数量，新增 control 引用的积压
不在这个指标里。可以在现有指标模块补充分类型待发数量/最老年龄，使清理和发送预算可验证；
这不需要扩建监控服务，也不等于恢复此前暂缓的完整观测项目。

此外，只有 queue snapshot 从 Outbox 取最新 viewVersion；binding 和 Subagent 命令已有
自己的 source revision。是否有必要为每个仍存在的 Subagent 命令长期保留最后一条已发布
引用，应分别论证。建议先做有期限/工作预算的排空和分类型保留，保留所有未发布项与必要的
queue version head，不增加另一份状态存储。

### O02-03 · binding bootstrap 仍是全库边界，增加 Projector 不会提高它

`PostgresSandboxBindings.loadView()` 先读取全库至 65,537 行并检查上限，
`SandboxBindingView.load()` 随后才按所持分区筛选。
模拟全局 65,537 行全部属于分区 0，一个只负责分区 1、实际应加载零行的 owner 也启动失败。

这是上次验收已披露的容量限制，本次进一步确认它是 **全局上限**，不是每副本上限；
没有据此声称当前生产已到达上限。建议在 PG 查询阶段按 owner 范围分页加载，再做行数和
字节预算，明确快照/变更衔接。Kafka Streams 的任务/状态归属同样以分区为基础；这里借鉴
归属原则，不建议为这个问题引入整套 Streams 服务。
[Kafka 状态与任务架构](https://kafka.apache.org/41/streams/architecture/)

### O02-04 · Preview 是下一条值得测量的重复访问路径

[sandbox-preview-gateway.ts](../../packages/control-plane/src/sandbox-preview-gateway.ts)
第 292 行先查 Workspace 绑定，再查 owner；每个内容 HTTP 请求都会经过它。
[preview-connect.ts](../../packages/control-plane/src/preview-connect.ts)第 30 行为请求新建
`Agent({keepAlive:false})` 和授权 CONNECT；控制器还会核对资源 owner。
一个有许多 JS/CSS/图片资源的页面因此重复做路由解析和连接建立。

优先合并同一请求内的授权/Workspace/owner 查询，返回完整的已解析目标。
连接复用要按租户、资源、owner 和 VM 身份限定，并验证删除、切换和断连；目前只有静态
调用计数，未给出延迟收益。共享 VM/Workspace 跨多个物理 Session，不能直接假定当前的
Session Kafka key 已经解决其失效广播问题。

### O02-05 · 同一次图片解码可以先消除重复读取

[codec.ts](../../packages/session-attachments/src/codec.ts)第 91 行的 unpack 按引用逐次 get。
同一次解码里两个相同不可变引用，夹具记录到 **2 次 store.get**；生产 get 包含 PG 校验和
S3 下载。先做一次解码范围内的去重，比增加全局图片缓存更容易保持租户、哈希与容量边界。
这是明确的重复工作，尚无证据表明它是当前主要瓶颈。

## 对架构的评价与建议顺序

**应该保留的部分：** Pi 负责模型/工具循环，Worker 管运行期和原生 writer，Cube 管外部
效果，PG 管控制权威和正式历史，Kafka 管已接受输出和有序传输。这些边界对应实际故障
语义。Session/Lane 分离、模型 permit 与等待 Tool/Child 解耦、图片 claim check、
commit-before-dispatch 和明确 UNKNOWN 都有实际价值。

**主要欠缺是故障域和职责在函数契约处又混在一起。** PG 提交加网络确认被藏在同一个
`closePhysical()` 中；Outbox 的批次成为跨分区等待边界；一个 ready 布尔值代表多个不同
能力。这些问题比文件行数更重要。应先拆清“权威提交、准入屏障、异步传播”，再决定代码
如何分模块。当前没有证据要求把它们拆成新的微服务。

**单 Session 单 writer 与同分区串行处理是有意取舍。** 它们简化上下文顺序和恢复，代价是
同一会话内不能任意迁移 Lane，某些失败会影响整个 writer/分区。保留这个取舍并测量上限。
R02-03 的额外跨分区阻塞则不属于这种必要耦合。

**把控制状态经过 Kafka 并不意味着所有状态都适合这样处理。** 会话内的绑定、输入和
子任务很契合；用户权限、全局模型配置、共享 Workspace 的生命周期不同。
当前资源删除/实际投递资格等 PG 检查有具体理由，不应只为减少一次 SQL 移入最终一致缓存。

建议顺序：先修 R02-01/02/03 的组合故障，再修 R02-04 并合并无效通知；随后做一次端到端
SQL/写入预算对照。容量实测需要时推进 owner 范围 bootstrap；Preview 可作为下一条独立切片。
大规模/多节点 HA、自动 VM 重建政策仍需单独验收或讨论。

## 本次文档修正与验证

README 补上 PG/Outbox 控制变更路径、内存视图、SSE 与探测职责；包 README 删除当前已不存在
的独立 Broker/RunAttempt/Runner 反向依赖和归档描述，补齐 queue `viewVersion`。
ADR 索引、ADR-0210 的 per-Tool PG 旧描述和架构中的执行 fencing 表述已按当前实现校正。
这些是事实更新，没有批准或实施上述架构建议。

复现入口：

```bash
PI_CLOUD_REVIEW_DATABASE_URL=postgresql://pi_cloud@127.0.0.1:55449/pi_cloud \
  node --import tsx scripts/review-20261002-control-probes.ts /tmp/control-probes.json
PI_CLOUD_REVIEW_PROBE_OUTPUT=/tmp/view-probes.json \
  npx vitest run scripts/review-20261002-view-probes.test.ts --maxWorkers=1
```

第一条在指定的隔离 PG 中新建随机数据库，结束后删除。第二条使用模拟端口；5 项断言记录
当前缺陷/边界，不是未来修复的验收标准。修复时应转换相应断言，不能以这些“通过”宣称缺陷消失。

本次检查结果和所沿用的基线验证分别记录于
[验证汇总](repository-review-20261002-verification.json)。上一轮 1,562 个工作区断言和
124 项故障测试的业务代码与本基线一致，但本次没有把历史结果算作重新执行，也没有新增付费
模型或生产故障测试。业务修复尚未实施。
