# Session / Turn / Run 字段审查

日期：2026-10-08。基线 `8f0607f8`，schema 182。
范围仅限 `sessions`、`turns`、`runs` 及它们的读写、数据库依赖和输入受理边界。
这是审查与建议，未实施 schema、业务代码或运行服务变更。
[逐字段清单与验证结果](session-turn-run-review-20261008.json) 覆盖全部 105 列。

## 结论

- `sessions` 31 列、`turns` 22 列、`runs` 52 列；线上列名、类型、可空性与当前迁移一致。
- 第一批有 6 个明确精简候选：4 个没有业务读取的字段、1 个固定值字段、1 个重复时间字段。
  完成对应读写与索引调整后，总列数可由 105 降到 99。
- 更有意义的后续工作，是去掉 Turn 中重复维护的 7 个执行生命周期字段，让 Run
  成为这一层的唯一执行状态来源。Turn 的创建时间也可在同一轮整理时从 Run 取得。
- 建议先保留输入表与执行队列的分工。把整张 Turn 合进 Run 会使输入大文本、附件元数据
  进入执行队列表，并扩大公共身份、外键与原生 origin 的改动；列数减少不等于职责更清楚。
- 不删除 Session 与 Run/Turn 之间的配置快照，也不合并租约、封口、退出与恢复位置等
  具有不同故障语义的字段。列重命名与删除字段是不同的工作。

## 当前这一步究竟做了什么

普通 `POST /v1/sessions/:id/turns` 在一个 PG 事务中校验当前配置、保存输入，创建
Turn/Run、记录幂等指纹并分配 mailbox position。初始 `queued` 表示已受理；`ready_at`
区分可领取的队头与仍等待前序收尾的输入。这时没有向 Pi 提交原生 user Entry。

随后由 **Pi Worker 主动领取 PG 的 ready Run**，并原子取得/复用物理 Session 的执行
租约；控制面不是先从 PG 读出来，再通过另一条任务投递 RPC 把它推给 Worker。
PG NOTIFY 是唤醒提示，轮询覆盖通知丢失。Worker 在受信 Runner 内向 Pi 提交输入，
原生写入才进入 ingress → Kafka → Projector → PG 的日志路径。

队列视图变化可经现有 Outbox/Kafka 传播，这不等于输入已经进入原生上下文，亦不形成
另一条 Run 执行队列。参见 [Run 生命周期](../RUN_LIFECYCLE.md)、
[ADR-0131](../adr/0131-run-table-postgres-queue.md)、
[ADR-0179](../adr/0179-ready-runs-and-single-admission.md) 及
[领取代码](../../packages/runtime-core/src/run-executor.ts)。

## 发现

### R08T-01：Turn 与 Run 重复维护本轮执行生命周期（P2，设计债务）

重复字段为 `state`、`stop_reason`、`failure_code`、`failure_message`、
`failure_retryable`、`started_at`、`settled_at`。

数据库以 `runs_tenant_turn_unique (tenant_id, turn_id)` 限制每个 Turn 至多一条 Run；
普通输入和子 Agent 的创建路径都在同一事务里创建这对记录。Durable 恢复继续使用原
Run/Turn，没有一轮多 Attempt 的现行需求。当前启动、完成、失败、取消、恢复、
子任务准备失败和队列撤回均需要同步两份生命周期。

证据：

- [RunExecutor](../../packages/runtime-core/src/run-executor.ts) 的原子启动、完成与失败路径。
- [取消执行器](../../packages/runtime-core/src/run-cancellation-executor.ts) 的取消确认与失败路径。
- [队列操作](../../packages/control-plane/src/queued-input-service.ts)、
  [Stop 撤回](../../packages/control-plane/src/stopped-inputs.ts)、
  [恢复封口投影](../../packages/runtime-core/src/execution-stream-projection.ts)。
- [子 Agent 创建和收尾](../../packages/subagent-control/src/postgres-subagent-job-provider.ts)。

隔离数据库调用真实队列取消路径时，两表都正确变为 cancelled，但 `settled_at` 相差
3 ms，因为代码分别调用 `clock_timestamp()`。这只是双份记录同一个业务事件的例子，
不是严重时间错误。另一个刻意的单边写入实验确认数据库不会约束两表状态相等；
该实验不代表发现了生产路径上的状态不一致。

建议只在 Run 保存生命周期，聊天查询从 Run 映射公开 Turn 状态：

| Run 状态 | Turn 展示状态 |
| --- | --- |
| queued / running / completed / failed / cancelled | 对应同名状态 |
| cancel_requested | cancelling |
| timed_out | failed |
| settling | running；继续保持现有终态可见性规则 |

不能只删列：

- 现有 `turns_one_active_per_session` 独占约束必须迁移到 Run 的对应活跃状态，
  保持每个产品 Session/Lane 的顺序；同一物理 Session 的不同 Lane 仍可并行。
- [对话读取](../../packages/control-plane/src/conversation-reader.ts) 的封口前终态遮蔽必须保留；
  不能把业务完成直接视为原生日志收尾完成。
- 队列触发器、Session 可操作性查询、列表计数、Fork/Prune、取消与 Steer 的读取一起迁移。
  `turns_queued_mailbox_order` 等索引依赖 Turn 状态，不能遗留第二套排队判断。
- 已消费 Steer 的源输入、停止后退回输入、未启动取消和 Durable 恢复，都要覆盖。

这是改变存储职责的后续 slice，实施前应提交 ADR。减少的是双写、锁对象和状态转换分支；
已有一些写入使用 CTE 合并，不能据此声称网络 SQL 往返必然减少一半。

### R08T-02：四个字段没有当前业务读取（P2/P3，历史残留）

| 字段 | 当前证据 | 建议 |
| --- | --- | --- |
| `sessions.forked_from_session_id` | 子 Agent 写 null，受理查询选出但不使用；当前人类 Fork 使用 `conversation_parent_session_id` 和 fork Turn/Entry 锚点 | 删除旧列、旧外键、无用 select/null 写入 |
| `runs.conversation_base_seq` | 普通输入写一个序号、子 Agent 写 0；没有生产读取 | 删除；保留实际使用的原生 Conversation/Entry 上下文锚点 |
| `runs.output_projected_offset` | 每个原生批次和展示覆盖推进都写，恢复时清空；没有读取 | 删除该列及清理脚本中的赋值，保留真正的恢复进度 |
| `runs.last_heartbeat_at` | 在启动与部分状态转换时赋值，没有业务读取；实际续租更新 `session_leases.valid_until/renewed_at` 和 Worker 连接 | 删除旧列和旧赋值；保留实际租约与连接心跳 |

扫描覆盖生产 TS、操作脚本、当前数据库视图、函数、索引；这四列没有当前 SQL
视图/函数/索引读取依赖。空库应用全部迁移后，四个 `DROP COLUMN ... RESTRICT`
探针均成功并逐一回滚。应用仍有写入/选择这些列的代码，实际迁移需匹配更新应用。

`output_projected_offset` 特别值得处理：
[原生批次 Projector](../../packages/runtime-core/src/postgres-durable-commit-projector.ts)
目前每批更新 Run，除了三个 `coalesce` 的首次位置，就是推进这一无人读取的列。
删除后可进一步研究：在已持有 Run 锁并确认已有起点时，跳过仅用于初始化首次位置的
UPDATE。首批仍必须原子记录起点；每批的租约/封口检查、原生日志事务和分区 checkpoint
继续保留。这里尚未实施或测量性能收益。

真正的恢复起点来自
[分区 checkpoint 与未封口 Run 首位置](../../packages/runtime-core/src/accepted-fact-recovery.ts)，
不是 `runs.output_projected_offset`。实际租约更新见
[SessionLeaseCoordinator](../../packages/runtime-core/src/session-lease-coordinator.ts)。

### R08T-03：`turns.input_kind` 恒为 prompt（P3）

当前 CHECK 只允许 `input_kind='prompt'`，人类和子 Agent 两条插入路径也只写 prompt。
读取它的代码只是在确认这个常量。旧 continue 输入属于已移除功能，不能作为保留理由。

可以删除此列，把 `input_text` 的实际非空约束提升为 NOT NULL，同时保留
“文本非空或存在附件”的约束。内部/public port 所需的明确输入类型仍按当前协议构造，
不恢复旧输入种类，也不影响 follow-up / steer 的投递时机。

### R08T-04：创建与排队时间重复（P3）

`runs.created_at`、`runs.queued_at` 都以 `now()` 为默认值。两条当前创建路径在同一个
事务中创建 Turn/Run，没有分别设置这两个时间；恢复重新排队也不重写 `queued_at`。
隔离受理确认三份时间 `turns.created_at / runs.created_at / runs.queued_at` 完全一致。

建议先以 `runs.created_at` 作为受理/最初入队时间，替换队列排序、等待指标、API
`queuedAt` 取值和两个 ready queue 索引，再删除 `runs.queued_at`。
`turns.created_at` 可在 R08T-01 的查询迁移中从 Run 获取，不能直接删除现有索引依赖。

`available_at` 是最早可领取时间，子任务准备期间甚至设置为未来时间；`ready_at` 是
依赖满足的就绪标记。这两个时间/标记不是 created_at 的重复项。

### R08T-05：`runs.sandbox_id` 实际保存 Worker ID（P3，命名）

[启动赋值](../../packages/runtime-core/src/run-executor.ts) 明确写入 `this.#workerId`，
与 Session 租约中的 owner 对应。这不是执行 read/bash 的 Cube VM ID。
可在独立命名清理中改成 `worker_id` 并同步引用；不能把它当成重复 VM 绑定而删除。

## 应保留的相似字段

| 字段组 | 保留理由 |
| --- | --- |
| Session desired model/thinking/tier 与 Turn model/provider/credential snapshot | 当前选择与受理时配置不同；后续配置变更不能偷偷改变已受理输入 |
| Session 与 Run 的 project/workspace、目录、Agent 版本、工具权限 | 当前绑定与本轮执行配置/归属不同；Workspace 重绑保留旧 Run 的归属 |
| tenant/session/turn 外键 | 支撑租户约束、完整性和查询，不只凭“可 join 推导”删除 |
| Session ID、物理 Pi Session ID、Conversation ID、compute Session ID | 产品会话、原生存储/写者范围、原生对话 Lane、计算环境归属不同 |
| `next_mailbox_position`、`next_event_seq`、`row_version`、原生序号、Kafka offset | 分别对应输入顺序、展示事件顺序、并发版本、原生提交与分区位置 |
| `output_display_seq` 与 `output_display_native_seq` | 连接展示流与原生日志的可见性边界，不可用一个序号替代 |
| `lease_id`、`fencing_token`、Worker owner | 执行授权和旧写者拒绝；物理 Session 的共享租约没有变成独立 Run 租约 |
| execution released、Agent exited、output sealed、native output drained | 释放执行占用、退出证据、日志封口、原生输出排空是不同事实 |
| `queued_steer_id` 与 `input_return_request_id` | Steer 占用/消费确认和某次 Stop 的退回范围不同 |
| Session 与 Turn 的 `pruned_at` | 裁剪一个会话分支和裁剪其中一些轮次不是同一范围 |
| Session created/updated/last_active 时间 | 创建、配置更新与对话活跃时间不同，最近活跃索引参与列表分页 |

`runs.trace_id` 目前可以由 Run ID 确定性计算，属于可推导字段，但有日志、API 和唯一索引
消费者。优先级低于无读取字段和双份生命周期，本轮不建议为了再少一列扩大改动面。

## 推荐实施顺序与验收

1. 一个清理 slice 处理 R08T-02 的四列、R08T-03 的固定值列、R08T-04 的 Run 时间列。
   同时移除对应读写、约束与无效恢复赋值，替换时间索引；无兼容列或双模式。
2. 另一个有 ADR 的 slice 处理 R08T-01，并选择是否一并删除 Turn 的创建时间。
   保留 Turn 的输入、附件、模型/凭据快照、裁剪信息；执行状态统一由 Run 提供。
3. 实际测量原生批次的 Run UPDATE、受理/领取 SQL、队列排序和会话列表查询。
   不通过把所有列塞进 JSON 或新增元数据表来制造“精简”。

验收应覆盖：相同幂等键重试、并发提交/领取/取消、单 Lane 活跃唯一约束、队列编辑与
排序、Steer 消费与恢复、停止退回输入、封口前展示边界、同 Run 的 Durable 恢复、
子 Agent 创建/收尾、Workspace 重绑，以及原生批次重放/首位置/保留边界。
新部署使用匹配的 schema/应用，先关闭旧写者，不因开发阶段清理而省略执行权回收。

## 本次验证范围

- 线上仅查询 schema/视图/函数/索引/触发器与匿名聚合；三张表当时业务行数均为 0，
  不能把零差异统计当成生产一致性证明。
- 新建隔离 PGlite，应用全部 182 个迁移，调用真实受理、幂等重试和队列取消路径。
  5 项特征验证通过；四个 DDL 探针均回滚，临时数据库随后关闭。
- 105 列都有保留/精简/推导/命名分类。未修改线上表结构、服务或账户配置，未调用模型。
- 没有第二版实现、完整故障回归或性能对照数据；这些是后续实施的验收工作。
