# 控制链路修复与成本验证（2026-10-03）

状态：已修复、验证并部署。
决策：[ADR-0213](../adr/0213-control-recovery-and-propagation-budgets.md)。
对应 [October 2 review](repository-review-20261002.md) 的 R02-01–04、O02-01–05。

## 实施结果

| 项目 | 当前行为 | 重要边界 |
| --- | --- | --- |
| R02-01 | 本地拒绝准入；PG 原子提交 UNKNOWN 与同物理资源的 binding closure；随后确认发布 | 发布失败保留已提交隔离与可重试 Outbox；迟到旧 VM 不能覆盖替代 VM；普通 Tool 错误不授权销毁整台 VM |
| R02-02 | Worker 使用可用发布分区范围过滤原有 PG 接单查询 | listener/topic 存在不代表可执行；提示三秒过期；租约、封口和发布 fencing 仍是权威 |
| R02-03 / O02-02 | 16 个独立发送槽，通知与重试期限唤醒，一秒空闲补扫；清理独立分批运行 | 保留实体前驱、PG claim/CAS 与所有未发布项；queue version head 按需要保留；新增积压/最老年龄指标 |
| R02-04 / O02-01 | 同事务 queue/state 引用合并，保留最后版本；Subagent 真正完成变更后才发通知 | binding/command 不合并；不修改已发布 Fact；重复命令不产生虚假变更 |
| O02-01 | 记住待消费 Steer 的会话，ACK 后继续保留；已安装 Subagent 版本直接跳过 | 分区恢复、换主和扫描并发受 generation 保护；容量溢出回到限定会话的 PG 检查；实际投递仍看 PG |
| O02-03 | PG 先按 owner 分区筛选，再按主键每页读取 256 行 | 每 owner 65,536 条、64 MiB 序列化元数据上限；不声称 PG 无需扫描哈希元数据 |
| O02-04 | Preview 内容请求一次查询取得当前权限、Workspace 和 owner | 更换 Workspace、失去访问权限后旧凭证不能继续使用；没有全局权限缓存或跨资源隧道池 |
| O02-05 | 一次图片解码内，相同不可变引用只读取一次 | 租户、ID、MIME、长度、哈希共同构成键；保留完整性与取消检查；下一次解码重新读存储 |

PG migrations 163–165；Kafka Session log 仍为 v13，固定 Native Tool wire 仍为 2。
`input_queue` 引用可携带 `steerPending: true`，仅说明本事务加入过待消费输入；省略不表示权威的“没有 Steer”。
发布健康接口返回分区范围，属于匹配部署的私有协议。未新增服务或持久执行权威。
上线前额外收紧了逻辑恢复边界：事务内合并采用 PG transaction-local UUID，避免把内部数值事务号保存为跨集群恢复后的永久唯一键；连接复用、commit/rollback、保存点回滚与已发布引用保留均有真实 PG 测试。

## 固定工作量对照

[原始 Turn 数据](control-repair-turn-budget-20261003.json) 比较 `71e3964c` 与 `6ccbb6c5`，各六个完整无 Tool 原生 Pi Turn。
使用独立 PG 实例、三副本 Kafka、真实私有 HTTP ingress、原生 Session writer、控制投影和被观察的输入队列。
模型流使用固定回答，标识为 GPT-6 Luna，不请求外部模型。Worker 夹具使用真实 Run/lease admission，未纳入生产进程启动、模型网关和 VM 成本。
旧提交的所有 workspace imports 由测量 loader 显式解析到旧 checkout，避免共享 node_modules 偷用当前源码。

| 每 Turn 中位数 | 修复前 | 修复后 |
| --- | ---: | ---: |
| PG 客户端请求，含事务命令与轮询 | 341.5 | 142 |
| PG 应用事务 | 17 | 12 |
| 原生日志行数 | 6 | 6 |
| 输入队列控制引用 | 9 | 4 |
| Outbox 行数，含 seal | 10 | 5 |
| Kafka JSON 消息 / producer 提交调用 | 14 / 14 | 9 / 9 |
| Kafka JSON payload bytes | 8,441 | 6,832 |
| PG 语句 WAL bytes | 50,416 | 45,850.5 |
| 隔离 PG 集群 WAL bytes | 52,480 | 47,580 |
| 固定夹具完成耗时 | 8,746 ms | 6,747 ms |

SQL 降幅包含空闲 relay 补扫变化，不能全部归因于通知合并。触发器内部 SQL 不单独计入客户端请求，WAL 记录了相关写入；复用同一事务内 Outbox 行仍会产生 WAL。
额外使用 [PG pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html) 的顶层语句 WAL 统计，限定当前夹具数据库，避免重复累计触发器内部调用。集群 LSN 单个样本曾混入约 399 KB，而对应语句只有约 51 KB；两种口径都保留，不能用背景写入噪声论证收益。扩展仅用于隔离基准，没有加入生产。
Kafka bytes 不包含协议、复制或网络开销。数据来自单机小样本，不能外推生产吞吐或模型端到端延迟。
本轮 owner 冷恢复为 740 ms / 168 ms；较早一次测量为 210 ms / 227 ms，不能用单次结果证明恢复速度改善。分配/启动抖动与查询成本尚未分离。
V8 heap delta 出现 GC 导致的负值，不能据此声称内存节省。容量边界另由按 owner 分页和行/字节预算测试覆盖。

[定点复核](control-repair-probes-20261003.json) 还记录：

- 不运行 Pi 循环的生命周期夹具引用由 8 降至 3；该数字与上表完整原生 Turn 不混用。
- 一条发布请求被阻塞时，20 个独立分区全部开始发送；健康请求不再等待整批结束。
- 空闲 relay 每秒约 1 次 SQL，原来约 20 次。
- 五次已知 Subagent 版本通知回读为零；重复 no-op upsert 新增通知为零。
- 无 held Steer 的普通会话唤醒没有 SQL；相同图片的两个引用合并为一次读取。

## 验证与上线

全仓 `npm run check`：243 个测试文件、1,650 个断言通过，包含所有 workspace 类型检查与验收辅助脚本。
未在这次命令里开启 Kafka 的案例单独串行执行；真实 PG/RF3 的 ingress、binding 冷恢复、Subagent 唤醒和 producer fencing 五个断言通过。
格式、构建、文档、安装器、运行时策略、Helm、可观测配置、镜像依赖闭包和 high 级别依赖审计通过。
故障清单首轮发现一个参数化测试的名称引用缺少 `(true)`，测试本身已在全仓通过；修正精确定位并增加逻辑恢复用例后，最终固定提交的 **133 / 133** 项故障测试通过。

部署前已确认无活动 Run、lease、未封口输出或待发 seal，并保留 PG dump、配置和回滚镜像标签。
原有 174 行 native log 摘要为 `3d5d7c8afb87d46da35e9b88714128d0`。原开发机在本次部署前已经记录为 UNKNOWN；这不是本次修复造成的状态变更。
Guest 构建输入仍为 `e661c7d9d5798d4ef1f0761df29594163cb6da13`，无需重建 Guest/Cubelet 或替换既有 Workspace Volume。
已部署 `6ccbb6c5` 的 Control Plane、两台 Worker 和 Web，schema 为 165；32/32 发布分区可用。一个 Worker 首次启动失败后自动重启一次，随后健康；验收在两台 Worker 均健康后开始。

首次真实队列验收完成了六项浏览器操作，但首个 Run 等待 Tool 回包超时。Cube 阶段接收确认存在、Worker 回包缺失；排查发现部署前宿主重启后的 Docker PG/S3/Kafka IP 与 Cube EndpointSlices 不一致。已有配置脚本刷新了四个地址映射，Secret 和 Cubelet 配置均未改变。持续连接仍保留旧 broker 路由，第二次验收仍失败。排空测试 Run 后仅退出固定 Node 回包子进程，让 Cubelet 重建连接；第三次完整验收通过，未修改用例、延长超时或重放工具命令。三次测试都清理了自己的资源。

排查中 PATH 的 kubectl 实际调用 Windows 二进制，产生了误导性的 CA 报错。项目 Linux k3s 客户端验证原有 kubeconfig 有效，最终保留原凭据文件。此次未重启 Cubelet/Guest，也未替换原 Workspace Volume。自动跨网络地址/连接刷新尚未实现，已记录运行手册和 BACKLOG。

Subagent 的 13 轮真实 Luna 验收已全部通过，包含共享 VM、独立上下文、递归、消息消费、监督、取消和资源清理。

首次图片验收已完成三个图片 Run 与更换 Worker 后的无 Tool 回忆 Run，但恢复旧 Worker 时，Compose start 又启动了遗留旧版本 database-bootstrap，因数据库已有 163–165 而拒绝运行。已将命名 bootstrap 容器替换为当前 6cc 镜像（退出状态 0），并让验收脚本只恢复准确匹配的 Worker 容器。原有失败用例的会话已删除、Workspace 已标记删除。[完整图片复测](control-repair-image-live-20261003.json) 已通过：两张约 6.3 MB PNG 和一张约 25.1 MB original PNG，PG native record 分别为 778/778/779 bytes；换到不同 Worker/boot 后无 Tool 回忆三张随机柱状图，颜色排序全部正确，资源清理完成。

[最终队列/浏览器证据](control-repair-queue-live-20261003.json)、[Subagent 证据](subagent-production-acceptance-latest.json) 和 [133 项故障清单](control-repair-faults-20261003.json) 可复查。[Control Plane SIGKILL 验收](control-repair-cp-restart-20261003.json) 已通过：Cube 的 bash 执行计数为 1，原 Worker 未变化，结果在 Control Plane 恢复后完成持久化，资源清理完成。[真实 Vite/浏览器验收](vite-preview-acceptance-latest.json) 同样通过：根路径资源、动态 CSS/HMR、SSE、二进制 WebSocket、Cookie 隔离和清理均正常。

[最终健康与保留数据核对](control-repair-health-20261003.json) 确认原有 174 行 native log 摘要未变，原开发机 generation/runtime identity 与部署前一致（仍为既有 UNKNOWN 状态）。无活动 Run、未释放 lease、未封口输出或待发控制引用。六个本次测试图片对象在引用/upload/unsealed-Run 保护检查通过后按明确 ID 清理，恢复到原有零对象/零引用基线。临时 PG、Kafka 和旧版本测量 checkout 已移除，私有回滚备份保留。

## 保留的架构取舍

保持 Pi 原生循环、物理 Session 单 writer、PG 控制权威、同 Session Kafka 顺序和 Cube 外部效果边界。
控制面的本地缓存只代表可恢复视图，不承担最终权限、物理 VM 存活或 quota release 的权威。
同一 Session/分区内的串行等待仍存在；本次消除的是额外跨分区批次等待和无效往返。
自动 VM 重建政策、共享资源失效广播、跨资源 Preview 隧道复用以及多机 HA/大规模容量需要单独验收，未在这次修复中引入。
