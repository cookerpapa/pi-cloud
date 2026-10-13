# Session 直写传输测量

2026-10-14；ADR-0247 源码尚未部署。比较固定的 f5c0d9d8 入口与当前
KafkaSessionWriter，使用同一个独立三 Broker 测试集群。没有生产 Topic、
模型调用、Cube 或 PG 授权参与负载；测量时另有 PG 单元测试运行，因此这些
是实现取舍的初测，不是生产吞吐 SLO，也不能把全部差值归因于传输改变。

两种方式都保留 32 个控制分区生产者及同一 consumer-group 提交边界。
旧方式经原入口内存队列与分区生产者；新方式为每个物理 Session 增加一个
稳定事务生产者。每个 Session 预热一次，再顺序提交 64 条、每条文本 256 bytes，
跨 Session 并发。两者均以 Kafka 事务提交 ACK 为完成，不测 PG/模型/Tool 延迟。

| 模式 | Session 数 | 记录数 | 记录/秒 | ACK p50 ms | ACK p95 ms | ACK p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 分区入口 | 1 | 64 | 6.76 | 119.31 | 203.85 | 486.77 |
| Session 直写 | 1 | 64 | 24.98 | 36.19 | 63.73 | 83.53 |
| 分区入口 | 16 | 1024 | 45.15 | 296.95 | 755.85 | 987.04 |
| Session 直写 | 16 | 1024 | 94.82 | 137.74 | 300.01 | 389.93 |

资源代价可直接观察：新方式在已启动的控制生产者之上，16 个活跃 Session
增加 96 个本地线程、219 个文件描述符，RSS 增约 13.5 MiB。旧方式的数据
共用控制生产者，没有这组额外 native producer 线程。进程 RSS 包含分配器/
运行时保留，不能当作每 Session 的精确内存定额。冷 Session 关闭 producer；
子 Conversation 共用父物理 Session 的 producer，不按子 Agent 增加连接。

另一项隔离的背压测试向一个受限测试生产者提交 6000 条记录，接受 66 条，
拒绝 5934 条；消费者只读到 66 条，拒绝项没有发布。测试结束时 pending
records/bytes 都为 0。这是过载拒绝与恢复证据，不是整进程恒定内存保证。

测量脚本基于已有 `scripts/lib/publication-harness.ts`、
`run-kafka-accepted-fact-load.mjs`、`run-kafka-backpressure-check.mjs` 和历史入口
源代码。临时比较驱动与原始结果位于操作者的私有 `dist/session-work-benchmark/`
及 `/tmp/pi-cloud-session-work-transport-comparison.json`，不属于生产兼容路径。
资源和时间数据与此前的 [Kafka 原生隔离研究](kafka-native-fencing-20261013.md)
一起支持当前选择：减少 Worker 对控制面普通发布的依赖，同时接受活跃物理
Session 的 native producer 成本。更大规模必须另测，不能由这组样本外推。
