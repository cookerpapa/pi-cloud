# ADR-0248: Idle Worker management reconnect

Status: **deployed; live acceptance in progress**,
2026-10-14. Design baseline: `7d708e08`; implementation: `c744cfa7`;
serving release: `worker-reconnect-c744cfa7`, schema 189 / topic v16 / boot reply v3.

业主同意空闲 Worker 管理重连的优化方向，并要求回顾今早讨论、整理实施方案。
业主随后要求实施。源码、仓库检查、配套部署及 60/90 秒停机验证已完成；
[实施记录](../reports/idle-worker-reconnect-20261014.md)跟踪其余生产验收。
[研究记录](../reports/idle-worker-reconnect-plan-20261014.md)保存现有源码入口、
故障原因和成熟机制依据。本文固定实施边界，避免把管理连接恢复扩大为执行权恢复。

## 1. 今早讨论的目标与已有证据

兼容的控制面更新不应等待可能运行十几个小时的 Agent Loop 结束。Pi 继续运行在
Worker；PG 管租约，Worker 直接写 Kafka，Cube 管已接收的工具。控制面更换时，
投影、页面推送和后续派发可以短暂等待恢复，不承诺所有动作都没有停顿。

[完全停机验收](../reports/control-plane-outage-20261014.md)让控制面零副本约 65 秒，
验证原 Worker/Run/Session 租约/VM 继续、日志缓存在 Kafka、同幂等键的新请求恢复
后只创建一个 Run。另一个空闲 Worker 因 `heartbeat_timeout` 被退役，重连被拒，
容器重启一次。这是本切片要修正的行为。

Worker 使用稳定的 Service 地址 `control-plane:3000`。旧 WebSocket 断开后，
客户端已会退避重试；`open` 表示网络握手成功，随后发送 `supervisor.register`。
收到登记确认后才恢复管理通信和领取。地址发现和这套重连协议已有实现；要改
的是过期判定与登记准入。

目前 Deployment 配置为先起新 Pod、后以 SIGTERM 退出旧 Pod。单纯杀容器会按
原镜像重启。完整 matched release 仍会排空整套系统；此前滚动和零副本测试均为
同版本恢复，不能当作不同 schema/Worker 版本兼容证明。

## 2. 决定

将空闲 Worker 的管理连接过期与 Worker Boot 退役分开：

1. 现有 `supervisor_connections` 增加 `expired`，表示该连接不可再使用。
   `fenced` 继续表达随启动身份隔离而关闭；不增加表或第二份执行租约。
2. 空闲豁免要求 Worker 为 ready、没有未释放的 Session 租约、没有待完成的
   Worker 退役，且当前 Boot 凭据有效、未撤销。缺乏新鲜租约不能证明真正空闲。
3. 满足条件时仅结束旧连接，不将 Worker 标为 failed，不创建退役任务。
   同一 Worker ID、Boot ID 可以通过新传输再次登记，获得新的 connectionId。
4. 已被替换、撤销、failed/draining/terminated 的 Worker 不因此复活。存在
   过期未关闭执行权时仍按现有封口与恢复规则处理。忙碌 Worker 的新鲜 PG 租约
   保护、直接续租和原生 writer fencing 保持原职责。
   实施中统一结束超时的连接：新鲜执行租约保护 Boot，但不再延长旧连接的
   `expires_at` 来表示管理通道仍可用。忙碌 Worker 同样以原 Boot 重新登记。
5. 只有当前授权仍允许重连的连接失效才返回可重试错误。旧连接消息不能续期、
   改写或关闭新连接；真正的身份失效继续终止。不能把所有拒绝都改为重试。

新连接登记仍由 PG 事务先持久化、后确认。已有 Run、Session Lease、原生任务
不因为管理重连重新创建。控制面实例身份与 Session 执行身份不绑定。

## 3. 必须一起守住的两个并发边界

**登记与新 Boot 发放。** 新 Boot 发放和连接登记复用现有 `supervisor_hosts`
行锁，事务内再次检查当前 Boot 授权；之后固定 Worker、连接的锁顺序。
覆盖“旧握手认证已通过，但注册前凭据被新 Boot 撤销”的情况，避免迟到的注册
反向隔离新 Boot。检查只在管理登记边界，不加到每次模型、日志或工具调用。

**领取与连接过期。** 复用领取的 Worker 共享锁和过期处理的排他锁。新 Run
最终领取语句验证当前连接有效，使用等待锁之后的新鲜 PG 状态及 PG 时钟，
优先合并进已有 SQL，不新增网络往返。拒绝时回滚领取，Run 保持 queued；不能
留下半条租约或把正常重连当成 Agent 失败。已有 Session 续租不依赖管理连接。
生产 Worker 的 `accepting_assignments=false` 不作为 PG 自主领取的拒绝条件。

长期离线连接退出 active 扫描和可用性统计，保留必要身份记录。再次出现新 Boot
或明确撤销时走既有退役流程。管理超时不是物理进程停止、VM 死亡或可释放配额的
证据；本切片不改变 Cube 清理、工具取消或 unsafe Tool 重放规则。

## 4. 实施顺序与验收

| 阶段 | 改动 | 完成条件 |
| --- | --- | --- |
| A1：连接生命周期 | schema/types、注册/心跳/清扫的共同过期判定、重连错误分类及可用性查询 | 真正空闲的有效 Boot 不因管理超时退役；旧连接永久失效；既有撤销分支仍拒绝 |
| A2：并发准入 | Boot 发放与注册的共享锁序、最终领取条件及可重试回滚 | 真实 PG 交错事务中无重复领取、半条租约、旧 Boot 反向隔离新 Boot；已过期执行权不能复活 |
| A3：自动化验证 | 更新现有网关、Boot、Worker 重连、领取与退出测试 | 注册先于清扫/晚于清扫、迟到心跳、重复登记、丢失 ACK、撤销凭据、过期未释放租约均覆盖 |
| A4：匹配部署与实测 | 按维护流程发布所需的 schema/应用版本，再扩展停机验收 | 控制面不可达 60/90 秒后空闲及忙碌 Worker 原进程/Boot 保持，连接身份更新；原工作继续，新工作只领取一次，测试资源确认清理 |

A1–A4 是一个完整纵向切片，不能只放宽注册检查而遗漏清扫、心跳、在途领取或
退役分支。故障测试区分 SIGTERM 与实际 SIGKILL，不把删除 Pod 元数据当成进程
停止证据。实测使用 GPT-6 Luna，保留账户、模型/provider 配置及凭据。

首次交付涉及连接 schema/领取语义时，走所需的匹配升级与排空，不声称它本身是
已经证明可混跑的控制面小更新。开发阶段不保留旧运行语义的兼容分支；任何清理
仍遵守 writer 排空和物理资源确认要求。

## 5. 控制面更新的后续工作

空闲重连切片完成后，按顺序补充已有交接验收，分别记录结果，不混入 A1–A4：

1. 注入 dispatch offset 已提交、Cube 接单确认未返回的窗口；验证现有恢复行为，
   不因投影重放重复执行任意 Shell，也不把无法证明的执行结果改成成功。
2. 验证仍存活控制面缓存了已退出 peer 地址的情况，再分别验证 workflow、终端、
   预览长连接的重连或明确结束行为。
3. 将退出、新实例就绪、Worker 登记、Projector 恢复、SSE 恢复分别计时；此前
   最长文字更新间隔包含模型生成时间，不能全部算作部署停顿。
4. 在这些结果基础上形成可复用的控制面单独发布入口：限定兼容应用更新，使用
   K3s 镜像替换、readiness 和 SIGTERM，记录原镜像/模板及失败回退结果；不要求
   Agent Loop 跑完。涉及数据协议、Pi/Worker/Cube 变化时仍走匹配发布。

这些是后续独立切片。当前不引入按 Run 分版本、版本 Topic、查询微服务或新的
调度系统，也不把所有前端 POST 都描述成已具备自动重试。前端未确认输入仍按
既有草稿/确认语义处理；验收客户端的同键重试只证明已测试的请求路径。

## 6. 验收发现的输入回执读取竞态

上线后原生输入验收的同键重试出现 HTTP 500。真实 PG 交错测试复现：在
READ COMMITTED 的输入准入事务中，先读 native head，再重建最新队列；Worker
并发替换 current-only 文档后，旧 head 对应的基底已不再保存，读取报缺基底。

重复提交只需要原输入的 fingerprint 和 acceptedAt。改用现有
`readHumanInputMetadataBatch` 的单条当前元数据查询，去掉无关的 Inbox 重建。
输入身份/Run 关联不变，投影未出现时仍交给原 Worker 幂等确认；不增加表、
历史保留、兼容读取或第二套输入队列，也不把整个写事务改成旧快照隔离级别。
这是对 ADR-0243 当前状态读取的修正，须通过原生输入与发布验收后配套交付。
