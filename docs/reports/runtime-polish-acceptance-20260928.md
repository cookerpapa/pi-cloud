# Writer、Projector 与 SQL 往返打磨验收

日期：2026-09-28。决定：[ADR-0199](../adr/0199-bounded-publication-and-projection.md)。
运行代码：`e9b41ce4051efee428df849b8387516f3ec6f66e`。

## 实现与失败边界

可信本地发布端现在明确区分“确定尚未提交”和“提交结果不确定”。发送前校验、
容量或大小拒绝会恢复当前 Lane 的已提交视图，不占用原生序号；同一物理 Session
的其他 Lane 仍可写入。超大单条记录与暂时排队饱和使用不同错误。
这没有增加后台重发队列，也不会重试已经执行的 Tool。

Kafka ACK 丢失、回执不匹配、ACK 后本地 apply 失败，仍会停止共享 writer。
恢复已提交视图本身失败也会停止 writer。不能把超时、网络错误或 PG 暂时查不到
记录当成“没有提交”的证据。单 Session writer、原生 Pi 0.84.1 Agent Loop、
单调 dispatch commit 和 UNKNOWN/no-replay 合同保持不变。

同一 writer 的冷读等待共享一个在途投影查询和单调已观察位置。读取者单独取消；
全部取消后不再启动下一轮查询。已缓存进度也不能跳过当前 owner 检查。
这只是进程内读协调，不是第二个持久化游标，也没有恢复每 Step 的 PG receipt。

原生日志投影和 seal 事务在取锁前设置 PostgreSQL 事务局部预算：每次锁等待
2 秒、每条 SQL 10 秒。超时由 PG 取消并回滚，位置不前移，Tool 不派发。
记录随后仍按分区顺序重投；COMMIT 回应丢失仍由原有幂等投影处理。
这不是整个 record 的总时限，也不覆盖连接池获取、所有 API SQL 和外部路由。
持续失败的记录仍会阻塞其分区；其他分区保留原有并发。

## SQL 往返

下表统计组件内部普通分支的客户端 SQL，不含驱动 BEGIN/COMMIT，已计入新增预算设置。
基线来自打磨前源码及调用跟踪；当前数字由真实 PostgreSQL 回归断言锁定。
首次 scope/closure 缓存缺失、Fork 祖先、分页锚点、标签和恢复分支可能增加查询。

| 路径 | 修改前 | 修改后 | 说明 |
| --- | ---: | ---: | --- |
| 原生 Record 投影 | 8 | 8 | 合并 Run/分区进度省 1 次，预算设置增加 1 次 |
| 含 Entry 的普通投影 | 9 | 8 | 再合并 Lane head/Session counter 写入 |
| Broker 单次操作授权 | 3 | 2 | runtime 行锁后，同一新快照检查 owner 与 Run 权限 |
| 普通非 Fork、非空会话第一页 | 9 | 6 | 复用首节点，合并环境证据与 Entry/Record 读取 |
| 其中 canonical transcript 读取 | 4 | 3 | 两个可用索引的 UNION ALL 分支，一次返回原生数据 |
| 输入接受 / Worker claim | 6 / 9 | 6 / 9 | 保留已验证的授权与快照边界 |

没有把“Session 取锁”和“锁后读取最新状态”合并到同一 SQL；否则可能读到等待
锁之前的旧快照。完成/释放阶段决策时刻、过期条件和锁语义不同的授权查询保留。
UNION 查询计划验证两支均可使用既有索引，没有新增表、索引或兼容存储布局。

## 计时与受控测量

[受控 Lane 样本](runtime-polish-measurements-20260928.json) 使用真实 writer、本地 Pi
in-memory backend，固定模拟 5ms 发布 ACK；1/4/16 Lane 各写 3 次，无模型调用。
它用于分辨串行排队位置，不是生产吞吐、优化百分比或 Agent Team 验收。

| Lane 数 | 写入数 | writer 排队中位数 | prepare 中位数 | publish 中位数 | 共享进度 SQL |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 0.005ms | 0.097ms | 4.761ms | 1 |
| 4 | 12 | 16.373ms | 0.118ms | 5.270ms | 1 |
| 16 | 48 | 79.257ms | 0.055ms | 5.181ms | 1 |

该样本表明同一 writer 等待 ACK 时的排队仍存在，未通过分配第二套序号或提前
承认成功来隐藏。新的指标可继续区分 writer 排队/准备/apply、图片准备、producer
排队/ACK、PG 投影、dispatch commit 与 Tool 路由；这些是嵌套时长，不能直接相加。
计时回归中，100ms 图片上传与 7ms Kafka 等待分别记录；监控故障不能改变写入结果。
慢/失败记录日志仅含定位字段和安全错误码，没有内容、参数或原始异常正文。
[部署后进程计时](runtime-polish-measurements-20260928.json) 是本次运行窗口的累计数据，
不与旧版本合并了上传时间的指标做虚假的直接延迟比较。

## 验证、部署与清理

[验证记录](runtime-polish-verification-20260928.json)：全仓 `npm run check` 在隔离真实
PostgreSQL 上通过，**1,392 项通过、3 项 opt-in 跳过、0 失败**；共 211 个通过文件和
2 个跳过文件。跳过项为 Kafka topic policy 与两个 Cube provider 独立开关用例，
不把它们计为成功。包括 Pi 官方 Session backend conformance 的 29 项真实 PG 检查。
全工作区类型检查、构建、格式、文档、运行预算、监控、镜像闭包与构建上下文均通过。

[故障矩阵](runtime-polish-faults-20260928.json) **86/86**，新增证明发送前拒绝的 Lane
隔离、共享等待的单独取消/owner 检查、PG 锁及语句超时回滚、同 offset 重投和其他
分区进度。第一次矩阵运行有两项因缺少 conformance URL 而跳过；补齐环境变量后
重新完整执行，以上结果来自后一次完整运行。故障报告如实保留执行时的基线 HEAD
与 dirty 标记；验证记录包含最终源文件摘要和部署版本。

[真实 Luna/Cube 验收](runtime-polish-live-20260928.json)：最终三轮文件工具共有
**13 次成功调用**，覆盖固定内容 write/read/edit/bash、最终字节比对、1.5 MB 输出的
原生截断、`/tmp` 与符号链接。随后另一轮 Bash 先 fsync 写入一行，再等待 40 秒；
确认效果已经发生后 SIGKILL Projector，约 **14.796 秒**后恢复。Run 完成，文件仍
为一行。四个验收 Run 的 Kafka 核对为 **14 条合并调用、0 条独立命令、0 条独立固定
工具意图**，完整 Assistant 先于对应调用。

前两次严格文件工具验收未通过，原因均是模型生成的某个 edit `oldText` 不匹配
刚写入文件；同一 Run 随后修正成功并完成。第二次还逐项验证了模型原始参数与
原生意图参数完全一致。两次记录没有被丢弃，列在同一验收文件的 `earlierTrials`。
随后只改验收驱动：首场景给定文件全文与唯一替换标记，并新增最终文件字节校验；
仍要求每次工具调用成功。部署中的运行代码保持上述版本，修订驱动另有内容摘要。

[切换与清理记录](runtime-polish-rollout-20260928.json)：Control Plane、两个 Worker、
Broker、Web 与 bootstrap 版本一致，五个应用实例最终健康。切换前保存私有 PG 备份，
**1,202 条原生日志**切换前后正文摘要均为
`da5fb0246da4c3b373b41392b893f3a0`。无数据库迁移，Guest 标识仍为
`dbcdd74b623a27ffbdf266c706e2e09331c0532c`。

四个本次测试 Workspace（包括两次早期试验）的字节存储都已 purge；隔离测试 PG
及其匿名 Volume 已删除。最终未结束 Run、当前 owner、未封口 Run、未结束原生
operation 全为零。测试会话按已有归档合同保留，未清除用户历史。

没有实现 Agent Team/Graph、新 consumer、分区内乱序提交、DLQ 跳过或第二个查询权威。
本次证据不代表任意 shell 的 exactly-once，也不代表物理多节点 HA。
