# Worker 领取 Run 的表设计审查

日期：2026-10-10。源码基线 `7542a964`，线上 schema 183。
范围：Worker 从 PG 选择 ready Run、取得物理 Session 租约、原子登记 running；
包括相关表的生命周期、索引和恢复证据。未修改产品代码、迁移或运行服务。

## 结论

现有职责划分符合 ADR-0180、0229、0238：PG 决定谁可以执行，Pi Durable 决定
原生任务如何继续。没有发现需要重新合表、恢复 RunAttempt 或引入另一套队列的依据。
确认两项查询/索引问题、三个可删除的历史字段，以及一项 Worker 命名债务。
这些发现不是新的执行授权或恢复机制缺陷；没有在本次范围内发现 P0/P1 问题。

线上读取只涉及 schema、约束、索引和函数定义。隔离 PG 应用当前完整迁移后，
相关三组测试共 **59 项通过**。执行计划探针使用合成历史，不构成生产容量或延迟承诺。

## 发现

### R10C-01：领取查询未带子任务索引的租户前缀（P2）

[RunExecutor 的父任务存活检查](../../packages/runtime-core/src/run-executor.ts#L555)
使用 `e.child_run_id = candidate.id`，而现有唯一索引是
`subagent_executions(tenant_id, child_run_id)`。
这个检查也用于普通根 Run，以确定它没有已失效的父任务；不只在领取子 Run 时执行。

在隔离 PostgreSQL 17.6 中，捕获真实 `dispatchNext()` 的候选 SQL，将其中子任务表
换成保留当前列、CHECK 和全部索引的 LIKE 克隆，填入 5 万条合成历史。
领取一个普通根 Run 时，当前条件在该子查询使用 **391 个共享缓冲页**；
仅增加 `e.tenant_id = candidate.tenant_id` 后，使用同一组合索引只需 **3 页**。
两次都正确确认该 Run 没有父任务。

当前并不是完全没有使用索引，而是缺少首列条件，导致索引访问范围过大。
建议补全租户等值条件，保留父 Run 当前租约、有效期及 accepting-effects 检查。
不需要新缓存、新表或 child_run_id 单列索引，也不减少业务 SQL 的往返条数。
修复时增加有历史数据的计划检查，并覆盖根 Run、存活父任务、已关闭父任务和共享家族领取。

### R10C-02：Run 状态历史缺少按 Run 查询的索引（P2）

领取事务将 queued → running 写入 `run_transitions`。
[Run 详情读取](../../packages/control-plane/src/control-plane-store.ts#L1446)
按 `(tenant_id, run_id)` 过滤，再按 `(occurred_at, id)` 排序；当前表仅有 `id` 主键索引。

这与历史迁移有关：最初的索引是 `(attempt_id, occurred_at)`，
[Run 身份合并](../../packages/database/src/migrations/145_run_execution_identity.ts#L67)
删除 `attempt_id` 时，其索引一起被删除，之后没有补对应的 Run 索引。

保留当前表列、CHECK 和索引的隔离克隆中，查询目标 Run 的 5 条记录，
当前计划顺序扫描并过滤另外 **100,000 条**，读取 **1,539 页**。
增加 `(tenant_id, run_id, occurred_at, id)` 索引后，索引扫描只读取目标 5 条，使用 **4 页**。
这里只验证 Run 详情读取；它不意味着每次领取都扫描整个状态历史。

建议补这个索引，保留表本身。它记录 queued/running/恢复/结束等云端生命周期，
没有 assistant 文本，也不负责调度或恢复原生任务，不是与 Durable 竞争的第二份会话日志。

### R10C-03：物理 Session 表保留三个无业务读取的旧字段（P3）

`pi_sessions.created_at_ms`、`parent_session_id`、`name` 仍在
[创建会话](../../packages/control-plane/src/control-plane-store.ts#L596) 和
[人类 Fork](../../packages/control-plane/src/conversation-tree-service.ts#L1196) 时填写，
但当前产品代码、操作脚本和数据库函数/视图没有使用这些字段来读取时间、标题或分支。
fixture、历史迁移以及通用备份导出不构成业务读取。

产品时间/标题/分支取自 `sessions`；Durable 的原生关系来自其 canonical records。
这三个字段不是领取、租约、fencing、封口或原生恢复的输入。
在当前完整迁移后的隔离库中，对三列分别执行 `DROP COLUMN ... RESTRICT` 并回滚，均成功。
该探针只证明没有阻止删除的数据库依赖，生产删除仍需同步移除类型、创建/Fork 写入和 fixture。

建议删除三列。`pi_sessions` 仍然保留租户/物理 Session 身份、`lease_epoch`、
`unsealed_runs` 和生成的 `session_hash`，不能据此删除整张物理 Session 表。
修复验收应覆盖创建、独立 Fork、子 Conversation、原生 Storage 和恢复，不保留兼容列。

### R10C-04：Worker 注册表仍使用 Sandbox 名称（P3，命名）

当前 `sandboxes` 是受信 Pi Worker 的 boot 注册/状态表，
`session_leases.sandbox_id`、`supervisor_connections.sandbox_id` 和
`active_execution_scopes.sandbox_id` 指向该 Worker。
它们不是执行文件/Bash 工具的 Cube VM；Run 中的同类字段已在 schema 183 改为 `worker_id`。
见[当前数据库类型](../../packages/database/src/database-types.ts#L766)。

建议后续统一数据库表/列、类型和使用点的 Worker 命名，例如 `workers` / `worker_id`。
这是匹配升级中的命名整理，不合并 Worker 和 Cube 身份，也不删除 Worker boot 或连接记录。
其改动面比一个查询条件大，应独立核对所有引用，不作为前两项性能修复的前置条件。

## 保留的结构及理由

| 表/结构 | 当前职责 | 为什么不合并或删除 |
| --- | --- | --- |
| `sessions`（30 列） | 用户看到的会话/Conversation、当前偏好、资源绑定、云端状态 | 当前配置与某个已受理 Run 的快照不同；不同子 Conversation 共享物理 Session |
| `runs`（56 列） | 初始输入、冻结配置、ready 队列、逻辑执行生命周期和当前授权引用 | 同一 Run 可处理多个原生 follow-up/steer，并在旧写者封口后恢复 |
| `pi_sessions`（8 列，其中 3 列为清理候选） | 物理 Session 身份、单调 epoch、未封口计数及分区 hash | 所有 Lane 的共用写者协调点；不等于单个产品会话或单个 Run |
| `session_leases`（12 列） | 当前 Worker 所有权、有效期，以及旧写者关闭证据 | 同一租约可供多个 Lane/Run 共享；删除旧证据会破坏迟到写入与恢复判断 |
| `sandboxes`（8 列） | Worker boot 注册和 ready/draining/failed 状态 | Worker 可持有多组 Session 租约；不应复制其状态到每条 Run |
| `supervisor_connections`（24 列） | Worker 与控制面的连接身份、重连、心跳与过期 | 一个 Worker boot 可重连多次，连接不等于执行租约；普通领取不查询此表 |
| `run_transitions`（7 列） | 云端状态变更的查询/诊断记录 | 不参与原生任务回放，不保存聊天内容；应补访问索引 |
| `active_execution_scopes` | 由 Run、Session 与当前租约组合出来的视图 | 没有另外持久化一份授权状态 |

关键约束与边界仍然正确：

- 每个逻辑 Session/Lane 至多一个活跃 Run、一个 ready 队头；物理 Session 至多一条
  `released_at IS NULL` 的租约。未释放的过期租约仍占这个唯一身份；若租约已释放
  但日志尚未封口，`unsealed_runs` 仍阻止新的所有者接管。
- `pi_sessions.unsealed_runs` 是事务触发器维护的派生计数，避免为每次领取扫描旧 Run。
  回滚、重复 seal 和 Durable 重新领取均有测试覆盖；不应换成由多个组件各自维护的计数。
- Run 的 Worker/lease/fence 是本次授权的引用；`output_publication` 固定已授权的完整
  发布范围，并用于丢失 COMMIT 回执后的精确确认。它们没有独立生成第二套 epoch。
- Run 的 ready 与 running、Session 状态、租约和发布范围在同一事务确认；
  lease 的最后有效期检查使用取得锁之后的 PG 时间。Kafka 发布与原生执行都在提交后。
- 用户配置、Workspace 生命周期、固定 Agent/环境版本仍以 PG 为准。
  将最终领取授权换成 Projector 延迟内存视图，会丢掉原子竞争与旧写者隔离。

因此，九条普通业务 SQL并不能直接解释成九套状态。默认新租约路径仍是
9 条业务 SQL，加 BEGIN/COMMIT 为 11 次往返；已有租约复用为 8 + 2。
本轮建议先减少无效索引扫描和无用途字段，不以减少表数为目标改动授权链路。

## 验证和复现

```bash
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs --run \
  packages/control-plane/test/atomic-worker-admission.postgres.test.ts \
  packages/database/test/ready-run-cutover.postgres.test.ts \
  packages/database/test/native-input-run-cutover.postgres.test.ts \
  --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000

node --import tsx scripts/experiments/review-worker-claim-20261010/probe.mjs
```

- 三个测试文件、59 项通过：领取唯一性、多 Lane 共用租约、到期拒绝、事务回滚、
  COMMIT 回执丢失、封口后恢复、队头推进、schema 合并约束等。
- [探针](../../scripts/experiments/review-worker-claim-20261010/probe.mjs) 自建并清理隔离 PG，
  使用实际迁移和真实候选 SQL。合成历史克隆保留列/CHECK/索引，不复制 FK 和触发器；
  它只比较访问计划，不用于宣称合成历史满足完整业务生命周期。
- 执行计划输出在 `dist/reviews/worker-claim-20261010/probe.json`；测试日志在同目录。
  [精简结果](worker-claim-schema-review-20261010.json) 记录本次测量和限制。
- 未修改线上数据、部署配置或运行逻辑；未调用模型或 Cube。
  没有重跑与这次表审查无关的全仓/浏览器/真实 VM 验收。
