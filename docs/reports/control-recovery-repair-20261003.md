# 控制链路修复与成本验证（2026-10-03）

状态：源码及全仓检查完成，故障清单复核、匹配部署和生产验收进行中。
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

## 固定工作量对照

[原始 Turn 数据](control-repair-turn-budget-20261003.json) 比较 `71e3964c` 与 `f19eede6`，各六个完整无 Tool 原生 Pi Turn。
使用独立 PG 实例、三副本 Kafka、真实私有 HTTP ingress、原生 Session writer、控制投影和被观察的输入队列。
模型流使用固定回答，标识为 GPT-6 Luna，不请求外部模型。Worker 夹具使用真实 Run/lease admission，未纳入生产进程启动、模型网关和 VM 成本。
旧提交的所有 workspace imports 由测量 loader 显式解析到旧 checkout，避免共享 node_modules 偷用当前源码。

| 每 Turn 中位数 | 修复前 | 修复后 |
| --- | ---: | ---: |
| PG 客户端请求，含事务命令与轮询 | 367 | 143 |
| PG 应用事务 | 17 | 12 |
| 原生日志行数 | 6 | 6 |
| 输入队列控制引用 | 9 | 4 |
| Outbox 行数，含 seal | 10 | 5 |
| Kafka JSON 消息 / producer 提交调用 | 14 / 14 | 9 / 9 |
| Kafka JSON payload bytes | 8,442 | 6,831 |
| 隔离 PG WAL bytes | 53,044 | 47,172 |
| 固定夹具完成耗时 | 10,234 ms | 7,733 ms |

SQL 降幅包含空闲 relay 补扫变化，不能全部归因于通知合并。触发器内部 SQL 不单独计入客户端请求，WAL 记录了相关写入；复用同一事务内 Outbox 行仍会产生 WAL。
Kafka bytes 不包含协议、复制或网络开销。数据来自单机小样本，不能外推生产吞吐或模型端到端延迟。
一次 owner 冷恢复由 210 ms 变成 665 ms，未证明恢复变快；分配/启动抖动与少量新查询未在本样本中分离。
V8 heap delta 出现 GC 导致的负值，不能据此声称内存节省。容量边界另由按 owner 分页和行/字节预算测试覆盖。

[定点复核](control-repair-probes-20261003.json) 还记录：

- 不运行 Pi 循环的生命周期夹具引用由 8 降至 3；该数字与上表完整原生 Turn 不混用。
- 一条发布请求被阻塞时，20 个独立分区全部开始发送；健康请求不再等待整批结束。
- 空闲 relay 每秒约 1 次 SQL，原来约 20 次。
- 五次已知 Subagent 版本通知回读为零；重复 no-op upsert 新增通知为零。
- 无 held Steer 的普通会话唤醒没有 SQL；相同图片的两个引用合并为一次读取。

## 验证与上线

全仓 `npm run check`：243 个测试文件、1,649 个断言通过，包含所有 workspace 类型检查与验收辅助脚本。
未在这次命令里开启 Kafka 的案例单独串行执行；真实 PG/RF3 的 ingress、binding 冷恢复、Subagent 唤醒和 producer fencing 五个断言通过。
格式、构建、文档、安装器、运行时策略、Helm、可观测配置、镜像依赖闭包和 high 级别依赖审计通过。
故障清单首轮发现一个参数化测试的名称引用缺少 `(true)`，测试本身已在全仓通过；已修正清单的精确定位，随后完整重跑。

部署前已确认无活动 Run、lease、未封口输出或待发 seal，并保留 PG dump、配置和回滚镜像标签。
原有 174 行 native log 摘要为 `3d5d7c8afb87d46da35e9b88714128d0`。原开发机在本次部署前已经记录为 UNKNOWN；这不是本次修复造成的状态变更。
Guest 构建输入仍为 `e661c7d9d5798d4ef1f0761df29594163cb6da13`，无需重建 Guest/Cubelet 或替换既有 Workspace Volume。
生产验收结果在匹配部署后补入。

## 保留的架构取舍

保持 Pi 原生循环、物理 Session 单 writer、PG 控制权威、同 Session Kafka 顺序和 Cube 外部效果边界。
控制面的本地缓存只代表可恢复视图，不承担最终权限、物理 VM 存活或 quota release 的权威。
同一 Session/分区内的串行等待仍存在；本次消除的是额外跨分区批次等待和无效往返。
自动 VM 重建政策、共享资源失效广播、跨资源 Preview 隧道复用以及多机 HA/大规模容量需要单独验收，未在这次修复中引入。
