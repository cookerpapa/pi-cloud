# 原生日志存储调研与设计 Review

日期：2026-10-11。PiCloud 基线：`24031331c5b1077f28cb6983201b03722b24bda9`，
Pi Durable 1.0.0，schema 184。运行版本仍是 `publication-admission-c39a78f8`。
本轮是源码调研、隔离实验和文档修正，没有修改生产实现或部署新版本。
[结构化证据](append-only-storage-review-20261011.json)。

## 判断

**保留当前四张原生存储表和 Session 内的 `seq`。表数不是当前设计的主要问题。**
不可变正文、提交批次信息、当前状态索引、快照有不同职责；成熟实现通常也会分开保存。
本次发现一项恢复校验缺口、一项可复现的冷读开销，以及一项应明确讨论的保留策略。
没有找到仅为减少表数就替换 PG/Kafka、引入另一个事件存储或工作流引擎的依据。

这里所说的共性是设计模式，而不是所有系统必须采用相同表结构。Pi 的原生 SQLite
后端主要保留当前 Task/Submission 状态，PiCloud 还保留所有原生写入的历史版本，
两者的存储量不能直接当作同等保证下的性能对比。

## 参考范围与来源

同时检查了官方文档、源码、许可证和发布信息；不以博客中的目标架构代替实际代码。
Maka 的 Agent Graph、Workspace 版本体系不属于本次借鉴范围。

| 实现 | 本次来源基线 | 实际存储方式与可借鉴点 |
| --- | --- | --- |
| Pi Durable | 1.0.0 / `a13d35a`，MIT | SQLite 使用记录 ID、Conversation、Entry、Task、Submission、Document 和文档版本等表；JSONL 使用主提交标记与 Task/Document sidecar。Storage 要求原子提交、版本和读取语义，不强制一张日志表。 |
| Apache Maka | main `fa26868`，Apache-2.0 | SQLite `runtime_events` 保存不可变事实；还有 Session 顺序目录、Tool 投影、临时 partial 快照/片段等。日志与临时展示状态分开。 |
| Marten | `a6832ce`，MIT；发布列表已有 V9.48.0 | PostgreSQL `mt_events`、`mt_streams`，以及投影数据和进度；事件序号与流内版本分别存在。 |
| Apache Pekko Persistence JDBC | v1.3.0 DDL，并核对 main `712fed3`，Apache-2.0 | `event_journal` 同时保存全局 `ordering` 和实体内 `sequence_number`；快照单独保存，批量写入使用事务。DDL 还包含替代的 Durable State 模式，不意味着应用必须同时使用两种权威。 |
| Temporal | main `30c6256`，MIT；发布列表已有 v1.32.1 | PostgreSQL `history_node/history_tree` 存历史批次和分支信息，`executions/current_executions` 存执行状态。历史与当前状态并存；这里只参考持久化边界，不引入 Temporal 调度器。 |

Pi 的两种后端见
[SQLite schema](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/sqlite/migrations.ts)、
[JSONL 实现](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/durable/src/storage/jsonl/storage.ts)。
这说明“对齐 Pi 的 Storage”与“永久保存每个中间版本”是不同要求。

Maka 已有正式 Apache 源码发布：0.2.0-incubating，日期为 2026-10-08；
仍处于孵化阶段。本次代码观察来自所列 main 提交，不把后续开发版本混同于正式发布。
见[官方发布页](https://maka.apache.org/en/downloads/)、
[存储 schema](https://github.com/apache/maka/blob/fa26868b1d223acc833089e94b6834188926f49c/packages/storage/src/sqlite-runtime-schema.ts)、
[实际提交路径](https://github.com/apache/maka/blob/fa26868b1d223acc833089e94b6834188926f49c/packages/storage/src/sqlite-runtime-store.ts)。
其写事务结束后才通知读取方；不可变事件和 partial 的处理路径不同。不能从
“Log Is the Runtime”推断其所有中间输出都永久保存为不可变事件。

Marten 的双表与并发追加说明见[官方文档](https://martendb.io/events/appending.html)，
具体编号见 [EventsTable](https://github.com/JasperFx/marten/blob/a6832ce71f13d9bec76b999cbbe78793e96aea18/src/Marten/Events/Schema/EventsTable.cs)。
Pekko 的双序号和快照可直接核对
[v1.3.0 PostgreSQL DDL](https://github.com/apache/pekko-persistence-jdbc/blob/v1.3.0/core/src/main/resources/schema/postgres/postgres-create-schema.sql)。
其 main 改动了 tag 表的键，本报告不将该差异归入 v1.3.0。
Temporal 的历史/当前状态分离见
[PostgreSQL schema](https://github.com/temporalio/temporal/blob/30c625664a2bbc1bd4cd9022d71982cc473e6979/schema/postgresql/v12/temporal/schema.sql)。

没有部署或压测上述第三方服务；本次实际执行的是固定版本 Pi 与 PiCloud 存储实验。

## 对我们四张表的评价

| 表 | 保留理由 |
| --- | --- |
| `pi_durable_log` | 一条原生 StorageWrite 一行，正文保存为 JSON 文本；正常变化追加新版本。 |
| `pi_durable_commits` | 保存原子批次边界、`next_id`、写入条数和重复/冲突判断信息；属于批次元数据。 |
| `pi_durable_records` | 保存当前记录指针和薄查询字段。Task/Submission 可多次变化，不能把历史上的 pending 状态误当作当前状态。 |
| `pi_durable_document_revisions` | 定位文档 base/delta，并用每 64 次增量的派生快照限制恢复读取长度。 |

`session_leases` 是云端控制表，不应算成“又一份会话日志”。记录索引和文档索引可以
从提交目录与日志重建；不能因此把含 `next_id` 等信息的提交目录也当作随意可丢的缓存。

九月 [ADR-0197](../adr/0197-indexed-native-session-log.md) 的单份正文方案针对 Pi 0.84
的不可变 Entry/Record；1.0 的可变 Task/Submission 和文档增量改变了访问需求。
当前薄索引没有重新引入两份完整 transcript 正文，这部分设计有理由保留。

`seq` 是物理 Session 的提交版本，Kafka offset 是分区位置，`ordinal` 是批内写入位置。
Pekko、Marten 也区分实体/流内版本与较大范围的顺序。Pi 的 Seq 接口允许跳号，
所以理论上可以设计 offset 映射，但独立 seq 保持了原生日志与 Kafka 拓扑的独立性。
当前取号是已获授权的 Worker 本地操作，没有每批 PG 取号服务。

写入路径也基本正确：Worker 在 Kafka 确认后采用状态；Projector 将批次头、正文和
相关索引放在同一个 PG 事务中；新 Worker 等旧写入者封口投影后再冷恢复。
本次正常重建的索引内容完全一致，重复批次不重复插入，冲突内容被拒绝。
这些是本次保留当前主体设计的证据，而不是仅根据框架风格判断。

## R11L-01：重建缺少批次完整性核验（P2）

位置：[rebuild](../../packages/pi-session-postgres/src/durable/postgres-projection.ts)。
它读取提交目录中的 `seq/next_id`，按现存正文重新生成索引，没有核对 `write_count`，
也没有验证现存正文与提交摘要的一致性。

在一次性的测试数据库里，正常写入后关闭 Storage，再分别制造两个异常：

- 保留第 2 批的头部（`write_count=1`），删除该批唯一正文。重建成功，没有发现实际行数为 0。
- 把一条 Entry 的正文改成另一个合法 JSON，而保留提交指纹。重建仍成功，读取返回修改后的内容。

这是**受控异常数据实验**，不代表线上已发生损坏，也不代表普通 PG 事务会部分提交。
问题在于：把索引重建当作恢复工具时，它目前会信任残缺或被改写的日志。
正常投影路径的“重复提交指纹检查”不能代替这一核验。

建议在重建/导入验证阶段检查批次条数、批内位置、当前格式要求的序号连续性及可重算摘要；
失败时利用现有事务回滚，保留旧索引。已有指纹覆盖输入 `origins`，而日志保存的是处理后的
`cloud_origin`，设计摘要校验时须核对可重建性，不能假定现有字段可直接充当离线校验和。
这应是有测试覆盖的恢复校验，不能转成每次普通读取都重扫日志。

## O11L-01：一次冷文档读取重复获取创建正文

位置：[冷读取与查询缓存](../../packages/pi-session-postgres/src/durable/published-storage.ts)、
[PG 读取](../../packages/pi-session-postgres/src/durable/postgres-projection.ts)。

对同一份文档调用 `findDocument()` 后再调用 `document()`，当前过程是：

1. 按地址扫描，读取日志正文以取得文档头。
2. 按 ID 再取一次记录，重新读取同一创建正文。
3. 获取文档版本，又读取 base 正文来还原内容。

第一步已经返回的文档头没有进入按 ID 的现有读取缓存。用 512 KiB 文档 base 的隔离夹具，
在初始化 head 查询之后测得：

| 方式 | SELECT 数 | 返回的日志正文总字节 |
| --- | ---: | ---: |
| 当前实现 | 3 | 1,573,317 |
| 实验中复用已扫描文档头 | 2 | 1,048,878 |

两者还原内容一致。这里统计 SQL 结果中的正文，不包含完整网络协议开销；
也不是整个 Worker 启动的 SQL 总数或生产延迟改善比例。

建议先复用现有、受容量和生命周期约束的记录缓存，保留提交后的失效逻辑、读取顺序和租约边界。
进一步分离文档头与大 base 正文，需要测量后决定；目前没有必要为此添加新表或缓存服务。
实验只覆盖一次冷读的原型，没有把 monkey patch 或旁路缓存放进生产实现。

## D11L-01：明确中间状态的长期保留策略

PiCloud 当前保留每条原生写入，直到对应 Session 被删除；定期文档快照限制的是读取成本，
不删除原始日志中的旧 Task 检查点和文档变化。

原生 Pi JSONL 在 Task 终止后回收其旧 sidecar，在 current-only 文档换 base 或退休后回收
对应旧内容；原生 SQLite 更新当前 Task，并清理不再需要的 current-only 文档版本。
所以“对齐原生执行和读取语义”并不天然要求永久保存所有中间状态。

同一组合成写入包含 128 次 16 KiB 检查点更新，最后 Task 终止、文档换新 base：

- PiCloud 日志保留 130 个 Task 版本，Task 正文合计 2,123,302 字节；当前记录索引只有 3 行，
  文档版本索引只有 1 行。
- Pi JSONL 已回收 Task sidecar，剩余文件合计 18,388 字节。
- Pi SQLite 当前 Task 只有 1 行、正文 192 字节，文档当前 base 也是 1 行。

该对比说明**保留承诺不同**，不说明 SQLite 比 PG 快多少；文件布局、WAL、fsync 和副本保证不同，
不比较跨后端吞吐。PG 物理表/索引/TOAST 大小单独保存在结构化结果中。

另外执行了真实 Pi Harness 的模拟模型流式回答：16 KiB 答案在本次节奏下产生 70 批提交、
81 行日志正文，共 44,630 字节，其中 68 次文档变化占 25,520 字节。最终记录索引 9 行、
文档版本索引 4 行。流式批次数受时序影响，并不是每个同样大小的答案都固定产生这些数量。
这里使用增量写入，没有发现本实验反复复制整份对话的证据。

建议先明确哪些历史用于用户回看、Tool 审计、恢复和 Fork，再决定哪些临时状态可以回收。
如果需要回收，应设计带完整性验证的检查点/保留边界，同时处理批次目录、图片引用和重建。
**不要直接过滤 Pi 已提交的 StorageWrite，也不要直接删除旧检查点行。**
这会改变当前 canonical-log 保留约定，实施前需要 ADR；本轮不做该架构变更。

## N11L-01：旧文档中的流式保留描述

[ADR-0147](../adr/0147-self-contained-pi-session-event-log.md) 中“不把文字片段终身写入 PG”
描述的是旧版本。Pi Durable 1.0 的文字/思考 partial 属于原生文档变化，会落入当前日志。
本轮修正其适用范围标记；当前运行时观察信息仍按 ADR-0201/0211 走独立的观察路径。

## 采用现有实现还是替换

本轮建议继续使用现有 PG、Kafka 和 Pi 的公共 Storage 接口。Maka 是另一套 Agent 领域模型；
Marten、Pekko、Temporal 分别带有自己的运行环境、事件模型或调度约定，并不是这个 Storage
端口的直接替代品。为减少表数接入它们，会增加映射和运行边界，目前没有测得足以支持这种
替换的收益。可直接采用的是其索引、事务、快照和失败语义的设计方法。

Kafka 也不是所有云 Agent 的必选项。我们为既定的发布确认、顺序封口和异步投影承担了
额外的恢复与运维成本；本次没有做 Kafka 与直接 PG 提交的消融压测，不能声称其吞吐收益。
当前单主机部署的故障验收也不能当作多物理节点 HA 证据。

优先顺序建议：先补重建校验，再去掉冷读重复，随后用真实试用数据讨论保留策略。
四表、独立 seq、单物理 Session writer、Kafka ACK、PG 冷读和 Cube 的边界保持现状。

## 复现和验证范围

```sh
node --import tsx scripts/experiments/append-log-review-20261011/probe.mjs
```

脚本使用固定镜像的临时 PostgreSQL，运行现有迁移；不接受继承的测试数据库 URL。
SQLite/JSONL 文件放在临时目录，完成后清理。模拟模型不访问提供商、不运行沙箱工具。
重建异常注入只作用于该临时数据库。脚本与结果记录了版本、时间和脚本 SHA-256。

本次没有修改运行代码，不重复整仓 CI 或生产故障测试。现有运行版本此前的完整验证仍见
[发布记录](publication-admission-20261011.md)。第三方源码快照保留在忽略目录供核对；
公开报告使用固定提交的来源链接，不提交下载的仓库副本或会话内容。
