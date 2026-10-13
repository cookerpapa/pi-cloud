# Kafka 原生 fencing 与 Worker 直接发布研究

日期：2026-10-13。代码基线：`c041ae68af31240f0f983427bdcc7bd16cfb28c3`。
范围：研究、隔离实验和文档；没有修改生产链路、数据库协议、部署或模型配置。
[ADR-0209](../adr/0209-control-plane-publication-and-sandbox-authority.md) 仍然有效。

## 结论

原生 Kafka 能完成生产者替换和隔离，不需要维护 Kafka fork。但是，
`transactional.id = physicalSessionId` 加一次 PG 授权检查，不能直接替代当前入口。
Kafka 的生产者代次与 PG 的业务租约代次没有自动对应关系：迟到初始化的旧
Worker 可以取得更新的 Kafka 身份，反过来隔离当前 Worker。

在初始化完成后重新读取 PG，能阻止这个反例中的旧数据写入。因此，
“不改 Kafka 的 Worker 直写方案”并非不可能；尚未解决的代价包括当前生产者被
误伤后的恢复、会话与子 Run 的不同关闭范围、控制变更的排序，以及生产者数量。
这是一项需要独立 ADR 和验收的发布协议变更，不能称为保持架构不变的小重构。

建议先保留当前按 Kafka 分区共享生产者的入口，补齐兼容控制面更新的有界交接。
如果测量证明 HTTP 入口成为瓶颈，再完整评估下述直写候选。现有实验没有证明
入口不可替代，也没有证明它是性能最优方案。

## 原生能力与当前使用方式

- Kafka 的稳定事务 ID 把前后两个生产者实例关联起来；初始化、生产者代次和
  事务隔离由 Kafka 负责。它不读取消息正文中的 PiCloud `fencingToken`。
  [Kafka Producer 公共接口](https://kafka.apache.org/40/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html)
  和 [librdkafka 事务说明](https://docs.confluent.io/platform/current/clients/librdkafka/html/md_INTRODUCTION.html)
  的 `Old producer fencing` 小节描述了这些保证。
- 当前入口已经使用这套原生能力：事务 ID 是 `topic + publication + partition`。
  [发布器](../../packages/event-log/src/kafka-publication-writer.ts) 和
  [分区读取器](../../packages/event-log/src/kafka-partition-reader.ts) 还将当前消费组身份
  与已确认的派发位置放入发布事务，保持位置单调且不擅自推进。
- [KIP-447](https://cwiki.apache.org/confluence/spaces/KAFKA/pages/103093950/KIP-447%2BProducer%2Bscalability%2Bfor%2Bexactly%2Bonce%2Bsemantics)
  是已采用的消费组/事务协调机制。它校验 Kafka 消费组的成员代次，而非外部 PG
  的 Session 租约。Worker 目前从 PG 独立领取物理 Session，不能直接借用
  Projector 的成员身份冒充分区所有者。改变 Worker 的放置和接管机制会改变架构。
- Kafka Admin 的
  [`fenceProducers`](https://kafka.apache.org/40/javadoc/org/apache/kafka/clients/admin/Admin.html)
  可以隔离事务生产者，但它也不能永久禁止持同一事务 ID 的新初始化，更不能
  自动验证 PG 授权。本次未对 Admin 版本做实测；关闭实验使用同 ID 生产者初始化。
- 当前固定 JavaScript 客户端的 `initTransactions` 只提供超时与回调参数，
  没有把 PG 签发的 epoch 注入 Kafka 生产者身份的公共参数。这里没有使用私有 API。
- Kafka 4.x 的
  [事务协议强化](https://kafka.apache.org/41/operations/transaction-protocol/)
  处理 Kafka 自身的事务边界，并不会把外部业务授权接入事务协调器。本研究不以
  “某个新版协议开关能识别 PG 代次”为前提，也没有升级生产依赖。

采用的是已有的 Apache Kafka（Apache-2.0）与 Confluent JavaScript 客户端
1.10.1（安装包声明 MIT），没有引入新基础设施。实验加载的 librdkafka 实际版本为
2.15.1；broker 使用仓库既有固定镜像
`apache/kafka@sha256:3f7b939115cd4872e9cee9369d80bd69712fde55f9902f46d793f64848dedc75`。
版本依据为锁定的安装包、运行时版本输出和镜像摘要；引用较新版说明不代表已部署该版本。

## 隔离实验

[驱动与复现说明](../../scripts/experiments/kafka-native-fencing-20261013/README.md)
使用本机独立三节点 Kafka、RF3/minISR2，以及真实 PostgreSQL。
PG 只创建用于表达 epoch/closed 状态的 `research_grants` 表，不接入生产
`session_leases`、Run、Outbox 或 Agent Loop，也不声称覆盖完整租约身份检查。
各个时序通过顺序执行真实操作构造，结果由
`read_committed` 消费者读到分区 EOF 后核对。

运行时间：2026-10-13 02:28:17–02:29:41 UTC，之后完成清理。
原始私有结果：`dist/research/kafka-native-fencing-20261013/results.json`。

| 实验 | 实际观察 | 说明 |
| --- | --- | --- |
| 同一事务 ID，旧生产者已初始化 | 新生产者提交成功；旧生产者返回 fatal fencing 错误 `-144` | 原生隔离有效；另一个 Session 的生产者仍可提交 |
| 把 PG epoch 拼进事务 ID | 新旧生产者都能提交 | 变成不同 Kafka 身份，失去互相隔离的作用 |
| 旧 Worker 先查 PG，接管后才初始化 | 已提交 epoch 8 后，epoch 7 的记录仍被提交并读到；当前生产者反被隔离 | 一次前置授权检查不足 |
| 初始化后再查一次 PG | epoch 7 不再写入；epoch 8 的原生产者仍被隔离，重新初始化后才继续 | 修复了此时序的旧数据问题，但存在可用性代价 |
| PG 已关闭 epoch 7，尚无 epoch 8 | 迟到初始化后的 PG 检查拒绝旧 Worker；日志仅有 seal | 必须检查关闭状态，不能只比较是否有更大的数字 |
| 旧 Worker 初始化后检查通过，随后发生关闭 | 控制方关闭 PG 授权、初始化同 ID 并提交 seal；旧 Worker 后续提交被 Kafka 拒绝 | 原生 fencing 能覆盖授权检查之后的这类停顿窗口 |

这里的负例是刻意构造的**不完整直写候选**。它们不是当前生产入口的漏洞报告。
正例也只覆盖列出的调度顺序，不等于证明完整分布式协议正确。

最关键的区别是：**PG 认可“谁有权执行”，Kafka 认可“谁获得当前生产者身份”。**
在不同系统里获得这两个身份，必须设计交接流程；两个地方都存在递增数字并不能
自动把它们绑定起来。

## 可行候选及未闭合的边界

一个值得保留的候选是：每个活跃物理 Session 使用稳定事务 ID，初始化后核实
PG 身份；整 Session 关闭先撤销 PG admission，再用原生 fencing 结束旧生产者，
提交封口，等待现有 PG 投影边界后恢复。普通追加可以继续避免每条消息查询 PG。
该候选只描述研究方向，未接入运行时。

尚需解决：

1. **迟到初始化会影响当前合法生产者。** 补充 PG 检查可以避免旧数据，但不能
   撤销已经发生的 Kafka 隔离。需要明确重建生产者、未知提交以及同 Run 恢复的关系，
   防止新旧实例互相反复重建、互相隔离。
2. **正常 Run 结束不等于整物理 Session 结束。** 子 Lane 可以结束而兄弟 Lane
   仍在运行。不能为了给一个 Run 写 seal 就抢走整个 Session 的事务身份。
   当前入口的 Run 级关闭与 writer 级关闭边界必须保留，不能用会话 fencing 代替。
3. **控制变更需要明确排序。** Workspace 绑定、关闭、取消和普通提交目前共享
   入口的 Session 队列。多个直接生产者即使写同一 key，也只保证最终追加顺序，
   不会自动复制当前 admission/closure 的先后约束。
4. **丢失 ACK 不变成安全重放。** 使用原生幂等生产者不意味着应用可以任意重新
   发送一批 Pi 状态，尤其不能以 Kafka 事务替任意 Shell 声称 exactly-once。
5. **控制面依赖不会全部消失。** 即使 Worker 可直接追加，Projector 仍负责工具
   派发、展示和 PG 投影；Worker 的有界本地覆盖层也不能无限代替 PG。直写可减少
   日志 ACK 对入口的依赖，但不是整个 Agent 对控制面独立运行的保证。

KIP-447 是另一种成熟组合，但让 Worker 的授权完全依赖 Kafka 消费组/分区分配，
会改变目前 PG 领取与 Worker 本地容量的关系。额外增加一个仅用于 fencing 的
“会话消费组租约”，也不是无代价的配置调整；它必须证明不会成为第二执行权威。

历史 [ADR-0163](../adr/0163-direct-log-and-unified-projector.md) 的 Worker 直写方案，
则选择在 Projector 根据封口位置忽略旧记录。这是一种不同的确认与过滤边界，
不需要假装 Kafka 能识别 PG fencing；恢复该方向也必须重新决策和迁移，不能
把废弃实现作为兼容路径重新接入。

## 活跃生产者的资源测量

每档使用全新的 Node 进程，连接同一隔离集群，初始化并预热后测量。
增量相对于该进程加载客户端后、创建生产者前的基线；FD 包含 socket、管道等，
不能全部称为网络连接。RSS 只代表本次小负载驻留量，不是每个生产者的上限。

| 活跃生产者 | OS 线程增量 | FD 增量 | RSS 增量 | 小事务 p50 / p95 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 6 | 13 | 2.25 MiB | 59.67 / 63.46 ms（3 次） |
| 8 | 48 | 100 | 8.50 MiB | 21.71 / 85.16 ms（24 次） |
| 32 | 192 | 405 | 30.75 MiB | 14.73 / 55.02 ms（96 次） |

这里按生产者逐个提交小事务，并未执行并发吞吐压测。不同档的样本量、集群预热
状态不同，不能解读为生产者越多就越快，也不能与历史 HTTP 入口测量直接相减。
本次没有测得“去掉入口能节省多少毫秒”。

当前方案的生产者总量主要随 Kafka 分区数量增长；仓库默认是 32 分区。
候选方案主要随**活跃 Session** 数量增长，而不是历史会话总数。活跃 Session 很少时，
直写方案可能需要更少生产者；数量很大时，则把线程、连接和事务协调压力分散到
Worker 池并随之增长。资源数据不是单独否决直写方案的证据。

## 验证与清理

- 六个原生能力/授权交错实验全部达到各自断言，包括成功复现两个不安全候选。
- 在同一个私有 Kafka fixture 上，现有
  [publication.integration.test.ts](../../packages/event-log/test/publication.integration.test.ts)
  两项通过：事务控制/中止尾部与不重复派发；真实旧发布进程 SIGSTOP、接管、
  SIGCONT 后旧写入拒绝。该回归不是“所有迟到初始化”或“无感滚动升级”的证明。
- 新实验文件通过 Node 语法检查；变更文件的 Prettier 检查、`npm run docs:check`、
  研究文件本地链接检查与 `git diff --check` 均通过。未修改运行时代码，未重复运行
  无关的全仓、模型或 Cube 测试。
- 所有实验生产者、消费者、PG 连接、主题和容器完成关闭；Kafka 私有网络已删除。
  完成后再次检查，无 `pi-cloud-test-kafka-*` / `pi-cloud-test-pg-*` 容器或测试网络残留。
- 未调用模型、未执行 Cube 工具、未变更账户/凭据/生产业务资源；没有上线动作。

## 与当前阅读和更新需求的关系

已讲完 Worker → 日志入口 → Kafka 的提交、分区、seq/offset 和身份隔离。
下一条阅读主线是 Kafka → Projector。

更新需求限定为新旧版本在交接期间可共存的控制面改动，保持协议、PG 数据语义、
Worker/Pi 与 Cube 不变。目标是在持续运行的同一 Run 中完成有界的入口/分区交接，
允许短暂停顿，不依赖所有 Agent Loop 自然结束。尚未实现这一更新能力；当前
[完整匹配发布流程](../MATCHED_RELEASE.md) 仍要求排空。原生 fencing 实验不替代
这项运行中更新验收。
