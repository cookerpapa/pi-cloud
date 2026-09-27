# D5 研究：让原生日志直接承担查询

日期：2026-09-27。生产源码基线：`08fb771715d380617489e4beca9e68ce1fa852c2`。
状态：研究和独立 PostgreSQL 验证完成；尚未决定或实施生产存储切换。

## 结论

**可行。完整正文可以只存一份，独立的 Entry/Record 正文表并非 Pi 查询能力的必要条件。**
在日志行上保存可索引的检索字段，按查询选择 B-tree 索引，并让 SQL 先定位需要的记录，
可以保留按 ID、Turn、Lane、序号和父节点读取的能力。

建议后续优先考虑 **有检索字段的 `pi_session_log`，加现有的 Session/Lane/标签状态**。
它比保留两张轻量 Entry/Record 表更直接，也避免了一部分“先查索引表，再查日志正文”的
读取。轻量表方案同样可行，是另一种布局选择；本次不把它实现为兼容层或中间迁移阶段。
两种方案都不改变 Pi 的公开 SessionStorage 接口、Kafka 确认、单 Session writer 或
Projector 的职责。

这不是“任何查询都只读几行”：全历史统计、完整树遍历、没有压缩边界的长分支，以及
当前的未完成操作检查，仍会随相关历史增长。尤其后者已经是当前实现的冷恢复成本，
不能用这次存储合并掩盖它。

## 为什么原来会有这些表

核对了会话中的设计讨论、当前 [ADR-0147](../adr/0147-self-contained-pi-session-event-log.md)
和实际调用点。独立 Entry/Record 表提供明确的检索字段、约束和分支/Fork 读取；
后来 ADR-0147 要求日志自身包含完整事实，正文因此同时存在于日志和查询表中。
它们由一个 Projector 在同一个事务里写入，**没有两个写入权威**。

当前代码已经有正确的优化：`findEntriesOnBranch` 先按父 ID 查元数据，再批量读取选中
Entry 的正文。实验保留这个查询方式，没有把现有实现虚构成“逐步扫描全部 JSON”。
活跃 Worker 的原生步骤主要使用内存状态；这里测的是持久化、冷读取和历史读取成本，
不是模型速度或整个 Run 的加速比例。

## 比较的三种布局

| 名称 | 正文保存位置 | 检索方式 |
| --- | --- | --- |
| A `full_copy` | 日志 + Entry/Record 表各一份 | 当前表和索引 |
| B `indexed_log` | 只有日志 | 日志的存储生成列 + B-tree 索引 |
| C `thin_index` | 只有日志 | 无正文的 Entry/Record 表，按日志主键取正文 |

三组从同一版本的真实迁移创建表结构。A 保留现有索引；C 保留索引但删除正文列；
B 增加 `item_id`、`item_type`、`parent_id`、`custom_type`、`lane`、`run_id`、
`operation_kind`、`timestamp_ms` 和 `turn_id`，由同一行的日志 payload 生成。
这些是实验字段名，正式迁移仍需确定可变关联字段的处理。

PostgreSQL 17 的存储生成列在写入时计算，可以避免查询分支元数据时反复从大正文提取
父节点和类型；表达式必须是不可变的、只依赖当前行，生成列本身不能被单独赋值。
见 [PostgreSQL 17 generated columns](https://www.postgresql.org/docs/17/ddl-generated-columns.html)。
这里采用现有 PostgreSQL 能力，不需要新存储引擎、缓存或另一套投影框架。

索引按实际访问方式设计，而不是对整个 JSONB 加一个 GIN 后期待所有查询都变快：

| 访问 | 候选索引或方法 |
| --- | --- |
| 顺序读取日志 | 保留 `(tenant_id, session_id, seq)` 主键 |
| 按 Entry/Record ID 定位 | `(tenant_id, session_id, item_id)` 唯一索引 |
| 消息分页 | Entry 子集的 `(tenant_id, session_id, item_type, seq)` |
| 分支恢复 | 从指定叶子开始，按父 ID 逐跳查元数据；到本分支 Compaction 停止，再取正文 |
| Turn 历史 | 按租户、Turn、kind、seq 定位，保留执行 Session 所有权过滤 |
| Lane 操作记录 | Record 子集的 `(tenant_id, session_id, lane, item_type, run_id, seq)` |

部分索引要求规划时能证明查询符合其条件。实验同时验证 custom 和 generic prepared
plan；固定的 `kind='entry'/'record'` 条件放在研究视图中，没有依赖某次参数值偶然选中
索引。见 [PostgreSQL 17 partial indexes](https://www.postgresql.org/docs/17/indexes-partial.html)。

## 实测结果

独立 PostgreSQL **17.6**，固定镜像摘要，与本地部署版本相同；2 CPU、3 GiB 容器内存、
256 MiB shared buffers，PGDATA 使用 2 GiB tmpfs。`fsync`、`synchronous_commit`、
`full_page_writes` 均开启。**tmpfs 测量不代表物理磁盘、复制仲裁或生产提交尾延迟。**

使用原生 Pi **0.84.1 InMemorySessionStorage** 生成两组数据：

- 2,000 / 20,000 条主分支 Entry，另有交错的 Child Lane、操作开始/结束、用量、Lane 和事实。
- 分别为 **6,702 / 67,002 条原生日志**，主分支最后 64 条 Entry 之前有一次 Compaction。
- 正文混合 768 B、8 KiB、32 KiB，包含变化的代码文本和确定性散列，未用重复 `x` 冒充大正文。
- 另有同 ID 的不同租户、90 条复制 Fork Entry，以及少量回滚/损坏分支夹具。

实验用只读视图让**现有 PostgresPiSessionStorage 读取代码**直接查询三种物理布局，
与 Pi 内存后端对照。另测已定位执行 Session 后的 Turn 正文查询和最后一条 Assistant
查询；这两个查询按原生夹具计算期望值，未运行完整产品历史端点。

**34 组检查通过**：两档数据各 12 类读取，以及游标、正反向分支、过滤和停止边界、
Lane/名称/标签、完整复制 Fork 的读取、租户隔离、事务回滚、ID/append 冲突和
缺失/损坏祖先诊断。研究没有运行候选后端的完整 Pi 写入 conformance，也没有测试
故障切换、图片上传或任意 Tool 效果。

### 存储与写入

以下为两档数据及小型验证夹具的合计，包含 TOAST、索引和表辅助存储，不含迁移所创建
但未参与实验的公共表。空间来自 `pg_total_relation_size`，不是仅对 JSON 文本计数。

| 布局 | 总空间 | 相对 A 减少 |
| --- | ---: | ---: |
| A 当前正文复制 | 190.97 MiB | — |
| B 日志带检索字段 | 115.25 MiB | **39.65%** |
| C 轻量查询表 | 119.72 MiB | **37.31%** |

索引空间并没有消失：三组都约 29.5–29.6 MiB。主要收益来自删除正文副本；B 的生成列
也占空间。这组结果不能外推为所有真实会话固定节省 40%，尤其图片已经是外部引用。
现有开发库样本很小且经过反复清理，未拿其索引膨胀计算节省比例。
小型 Fork 夹具采用投影重建后物化 Entry 的形式，未测量大量 COW Fork 的存储分布；
不能把本次以普通追加为主的节省比例直接套用于 Fork 密集的工作负载。

20,000 条主分支 Entry 对应的 67,002 条日志，每 100 行一批，一个事务和一条
data-modifying CTE 写入日志及对应查询表；每批最后一行携带 append ID：

| 布局 | WAL 增量 | 相对 A 减少 | 批次耗时 p50 / p95 |
| --- | ---: | ---: | ---: |
| A | 189.48 MiB | — | 15.12 / 24.99 ms |
| B | 121.20 MiB | **36.03%** | 12.58 / 18.53 ms |
| C | 126.48 MiB | **33.25%** | 11.80 / 18.19 ms |

WAL 是隔离实例的 LSN 差，可能包含后台活动；这里只有一次顺序装载，各组负载顺序
未随机化。批量、JSON 解码和 SQL 写法也不同于真实 Projector，不能把这些毫秒作为
生产吞吐承诺。三组 `LIKE INCLUDING ALL` 保留 CHECK/UNIQUE/索引，但**不复制 FK 或
触发器**，因此均未计入图片引用触发器及控制面关联检查的成本。

### 读取是否随历史增长

custom 和 generic 计划均验证了：

| B 查询 | 2,000 条主分支 Entry | 20,000 条主分支 Entry |
| --- | ---: | ---: |
| 消息分页 | 日志索引扫描返回 40 行 | 日志索引扫描返回 40 行 |
| 查最近 Compaction | 递归产生 65 个分支节点 | 递归产生 65 个分支节点 |
| 批量取上述正文 | 65 行 | 65 行 |

分支查询还有同一范围的父节点完整性检查，所以不能把“65 个节点”说成总共只有
65 次数据库页访问。父节点读取都是按确切 ID 的索引查找；generic 计划的元数据阶段
shared-hit blocks 为 390 / 520，B-tree 深度随数据量增长仍会影响成本。
恢复不能简单改成“取整个 Session 最后一个 Compaction”，因为那个 Compaction
可能属于另一个 Lane 的分支。

读取先预热，再轮换三组执行，每项 25 次。20,000 条主分支 Entry 的客户端 p50：

| 读取 | A | B | C |
| --- | ---: | ---: | ---: |
| 单条 Entry | 1.35 ms | 1.31 ms | 1.38 ms |
| 分页取 40 条消息 | 5.55 ms | 5.54 ms | 6.70 ms |
| Compaction + 64 条后续 Entry | 10.65 ms | 11.10 ms | 11.34 ms |
| 某次操作的结束记录 | 0.93 ms | 0.91 ms | 0.97 ms |
| 最近 40 个 Turn 的 880 条 Entry 正文 | 56.69 ms | 63.76 ms | 69.53 ms |
| 查未完成操作，limit=2 | 88.15 ms | 92.69 ms | 86.06 ms |
| 全 Session 用量统计 | 23.73 ms | 19.86 ms | 130.32 ms |

这些客户端时间包含数据库、socket、JSON 解析和图片解码入口（本夹具没有图片），
不包含网络 quorum、模型和 Tool。不能只比较 EXPLAIN 的执行时间：A 的完整 JSONB
可能在结果序列化时才解 TOAST，B 提取 `payload->'entry'` 会较早解码，EXPLAIN 默认
不把传输整个正文的成本计入。这也是同时记录真实客户端耗时的原因。

大批正文读取有代价：本样本 B 比 A 的 p50 高约 12.5%。C 用 scalar 子查询模拟
按日志位置取正文，统计查询会反复读取用量正文，因此明显更慢；这是**本次 C 查询
实现的成本**，不是证明所有轻量表方案都会如此。后续可用批量 join 或专门的聚合 SQL，
但不应因此增加第二份完整正文。

### 不能被索引自动解决的部分

`findOpenOperations(limit=2)` 要发现“有没有第二个未结束操作”。夹具中只有最后一个
操作未结束，它仍需检查旧的 starts/finishes。B 的 p50 从 10.85 ms 增至 92.69 ms，
A 同样从 9.72 ms 增至 88.15 ms。这个 `limit` **限制返回条数，不保证只检查两条**。
若要求极长 Session 的冷恢复严格有界，可以另外讨论只保留当前未结束操作的小型状态
投影；需要保证同一事务更新、重建和异常多开诊断。这不是再复制整个 Record 历史。

全量统计和全树导出也必须读取相关历史。没有 Compaction 或指定 oldest-first 边界时，
分支遍历可能需要更长祖先链。候选布局没有改变这些 Pi 语义。
类型过滤很稀疏时也可能检查更多候选或祖先，返回条数不能普遍当作扫描条数。

## 实验发现的 SQL 陷阱

第一版 B 保留旧的 `visible_entries = entries UNION ALL COW refs` 视图，同时把正文
改成 `log.payload->'entry'`。取 40 条消息时，计划先读取 **1,875 行**并计算正文，再
排序/限量，服务端约 41 ms。说明“已有索引”不等于“只读取最终返回的几行”。

ADR-0147 已让目标 Fork 日志包含完整复制正文。B 因而可以直接读目标日志，去掉这层
COW UNION；同一规模变为 40 行、约 0.36 ms 的 generic 计划。
[初版与修正计划](native-log-layout-initial-prototype-20260927.json)记录这次观察。
正式实现若还有合并查询，也必须先限定元数据，再读取正文，验证 LIMIT 与排序的位置。

实验 B 为复用现有分支 SQL 保留了一张**空的** refs 夹具表；其他 Entry/Record 名称是
研究视图。它们都不是建议带进生产的兼容代码。正式切换应修改调用点并删除旧层。

## 切换前必须处理的实际语义

1. **Turn 归属与可变关联。** Fork 拷贝可能保留原 Turn ID，产品历史必须继续按执行
   Session 归属排除副本，不能只用 `turn_id` 查询。现有 Entry/Record 的 Turn FK 是
   `ON DELETE SET NULL`，不可机械替换为不能单独写入的生成列。可以让可变关联保持普通
   字段，但须明确它与不可变日志绑定的关系。当前产品 prune 是标记 `pruned_at` 和移动
   Lane，不是删除 Turn；这不等于可以默默删除现有 FK 合同。
2. **Fork 生命周期。** 日志已自包含，B 能读完整复制分支。现有 COW refs 还具有指向
   源 Entry 的 FK，删除源 Session 会受此约束；本研究未运行完整源删除/跨 Fork 生命周期
   测试，不能把独立读取夹具当成它的验收。需明确去掉来源依赖后的删除、导航和重建行为。
3. **图片与保留策略。** 图片引用保留触发器在 `pi_session_log` 上，正文合并不需要改变
   S3 claim-check。但正式迁移必须保留此触发器、租户检查、Fork 引用保留和 Session 删除
   后的垃圾回收，验证 codec 还原后的 Pi 内容一致。
4. **写入与故障。** 单 writer 已分配的 seq、跨 Entry/Record ID 唯一、append 幂等、
   租约/epoch 校验、封口与投影事务不可弱化。B 只省掉派生正文写入；名称、标签和 Lane
   状态仍随日志一起提交。回放重建不能触发模型或重新执行 Tool。
5. **调用点收敛。** SessionStorage、native append、冷端管理写入、Fork/rebuild、
   canonical Turn 历史、Subagent 结果、queued-input 消费证明和树/prune 查询都需要迁移。
   改成日志查询不改变上层公开接口；不留下旧表 dual-write 或兼容视图。

## 可复现材料与下一步

- [实验脚本](../../scripts/research/native-log-layout.mjs)、[候选日志 DDL](../../scripts/research/native-log-layout.sql)。
- [完整数据、扫描计划摘要和源码 SHA256](native-log-layout-evidence-20260927.json)。
- 基线读取实现：[PostgresPiSessionStorage](../../packages/pi-session-postgres/src/postgres-session-storage.ts)。

在已安装依赖并可用 Docker 的检出中运行：

```sh
npm ci
node --import tsx scripts/research/native-log-layout.mjs /tmp/native-log-layout.json
```

脚本自行启动固定摘要的临时 PG，不接受部署数据库 URL；完成或抛错后删除其容器及卷。
可通过 `PI_CLOUD_LAYOUT_SIZES=200,2000`、`PI_CLOUD_LAYOUT_REPETITIONS=3` 做小型验证。
小表选择顺序扫描可能合理，脚本只对至少 2,000 条主分支 Entry 的重复父节点读取强制
断言索引计划。生产数据库、运行代码、Kafka、Cube 和模型目录均未修改。

下一步若采纳 B，应先记录替代 ADR-0147 中具体查询表布局的 ADR，再实现一个完整切片：
新日志检索字段/索引 → Projector 与冷写入 → 所有读者/Fork/rebuild → 删除旧表和旧 SQL。
验收需包括 Pi 官方 backend conformance、真实 PG 并发/重放、租户和 Turn/Fork 隔离、
图片引用生命周期及现有故障合同。这些属于之后的切换工作，不把本次研究标为迁移完成。
