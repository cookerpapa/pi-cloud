# 空闲 Worker 重连与控制面替换方案

2026-10-14。状态：**研究完成，方案待实施**。源码基线 `2520029d`；线上仍为
`session-work-6ac697f9`，schema 188 / execution-topic v16 / boot reply v3。
本次只读取源码、测试、线上配置和已有故障证据，没有修改运行策略或发布镜像。
业主随后同意该方向；[ADR-0248](../adr/0248-idle-worker-management-reconnect.md)
汇总今早讨论并固定实施顺序、并发边界和验收。本文保留研究证据，运行策略仍未修改。

## 1. 目前怎样替换控制面

需要区分四件事：

| 操作 | 当前行为 |
| --- | --- |
| 杀死控制面进程或删除 Pod | K3s 按 Deployment 当前声明重新启动，通常还是原镜像；这本身没有更新代码 |
| 更新控制面 Deployment 的镜像 | 当前线上及 Helm 均为 `RollingUpdate`，`maxSurge=1`、`maxUnavailable=0`；新 Pod 就绪后退出旧 Pod |
| 本次完全停机验收 | 缩到零副本，确认 Pod 消失，保持停机，再恢复一个副本；使用同一镜像，未验证不同版本混跑 |
| 维护的完整配套发布 | `run-matched-release.mjs apply` 仍要求 Run/资源结算、writer 排空，再更换应用、Cube、guest 配套产物；并非控制面单独更新 |

正常退出使用 `SIGTERM`。控制面有关闭流程，会释放 Projector/Kafka 消费职责，
关闭管理连接和各资源客户端。Worker 管理通道关闭码 `1012` 已被识别为可重试。
直接 `SIGKILL` 会跳过这些清理，需要靠故障恢复接管，不能把二者当成同一种退出。

线上 `terminationGracePeriodSeconds=720` 是强杀前的最长宽限，不是每次固定等待
12 分钟，也不是等待 Agent Loop 完成。此前验收停止旧 Pod 约 3 秒，新控制面
就绪约 9 秒；这是本机同版本、镜像已准备好的观察，不能作为升级耗时上限。

兼容的控制面替换不要求 Worker 中的 Agent Loop 跑完，也不需要 Worker 等到某个
Step 才重启。Worker、PG、Kafka、Cube 保持运行，已提交的进度等待 Projector 恢复。
需要控制面的下一次工具派发、管理请求和页面推送可能短暂等待。
当前没有新增一个专用的“控制面单独发布”运维入口，也没有实现严格等待每个
Cube 接单确认完成的交接屏障。

依据：[部署模板](../../deploy/helm/pi-cloud-platform/templates/control-plane.yaml)、
[退出流程](../../packages/control-plane/src/main.ts)、
[完整发布脚本](../../scripts/run-matched-release.mjs)、
[已完成验收](control-plane-outage-20261014.md)。

## 2. 空闲 Worker 为什么重启

管理心跳间隔为 10 秒，超时为 30 秒。原测试让控制面完全不可达约 65 秒。
控制面恢复后，已有连接超过期限：

- 正在执行的 Worker 持续向 PG 续 Session 租约，因此命中现有保护分支，保留原 Boot。
- 空闲 Worker 没有执行租约。当前分支将连接设为 `fenced`、Worker 设为 `failed`，
  写入 `worker_retirements`，拒绝同一 Boot 重连。
- Worker 收到不可重试的拒绝后退出，K3s 重启容器，生成新 Boot。

随后只读取证确认，这次退役记录的原因确实是 `heartbeat_timeout`，且已经完成；
旧容器日志为 `registration_connection_closed`、关闭码 `1008`。这是当前策略造成的
额外重启，不是依据现象猜测的 OOM 或 Cube 故障。

关键代码是 [Connection Manager](../../packages/control-plane/src/supervisor-connection-manager.ts)
的 `register`、`#expireConnection`、`#hasFreshExecution` 和 `#fenceSandbox`。
现有 [网关测试](../../packages/control-plane/test/supervisor-websocket-gateway.test.ts)
也明确断言空闲连接过期后 Worker 进入 `failed`；实施时要修改这个行为断言，
同时保留旧连接被替换后的拒绝测试。

## 3. 建议：连接过期只关闭连接，执行失效仍隔离执行

三种身份的用途保持分开：

| 身份 | 代表什么 | 此方案如何处理 |
| --- | --- | --- |
| Worker Boot | 这一次 Worker 进程启动 | 真正空闲、未被撤销或替换时允许保留 |
| 管理 Connection | 这个 Boot 到某个控制面实例的一次连接 | 过期后永久结束，重连生成新身份 |
| Session Lease / Epoch | 一个物理 Session 的执行与写入授权 | 继续由 PG 判定；不因管理重连延长、复活或跳过封口 |

推荐给现有 `supervisor_connections` 增加明确的 `expired` 状态，区别于 Boot 被
隔离时的 `fenced`。不新增连接租约表、调度器或消息通道。

新增豁免仅用于 **Worker 为 ready、没有未释放 Session 租约、没有待完成退役、
当前 Boot 登记凭据仍有效且未撤销** 的情况。不能用“没有新鲜租约”代替“没有
尚未关闭的执行权”：前者还包含已经超时、必须恢复收尾的执行。

建议流程：

```text
空闲 Worker 管理连接超时
  → PG 将旧连接标成 expired，停止把它计入可用连接
  → 保留未失效的 Worker Boot，不创建 Worker 退役任务
  → Worker 重新连接服务名，重新认证和登记
  → PG 验证 Boot 仍有效，签发新的 connectionId
  → 收到新的登记确认后，Worker 恢复领取新 Run
```

正在执行且租约新鲜的现有保护逻辑保留。存在过期未释放租约、Boot 已被替换、
凭据撤销、Worker 已经 failed/draining/terminated 等情况，不适用空闲重连豁免。
已失败的 Worker 记录不会因为这次更新重新变成 ready。

## 4. 必须一起处理的竞态

**领取任务与连接过期。** 当前领取事务用 Worker 行的 `FOR SHARE`，连接清扫
使用 `FOR UPDATE`，可以利用已有行锁确定先后。但生产领取路径没有配置管理连接
guard；只保留 ready 而不补准入，会允许某个在途领取在旧连接结束后提交。

因此新 Run 的最终领取 SQL 还应检查该 Worker 当前连接 active 且未过期，合并到
已有条件更新中，争取不增加 SQL 往返。先持有 Worker 锁，再在后续语句检查新鲜
状态，时间使用 PG 的 `clock_timestamp()`；失败回滚整个领取，不留下半条租约。
这类准入拒绝返回可重试的未领取结果，Run 保持 queued，不能当作 Agent 执行失败。
不能把 `accepting_assignments` 当作生产领取开关：目前 Worker 主动将它设为 false，
该字段服务于旧的管理通道派发语义，生产任务由 Worker 直接从 PG 领取。
已有 Session 的续租不增加管理连接依赖。

**旧 Boot 重连与新 Boot 登记。** 现在凭据在 WebSocket 握手时检查，注册事务
则锁 Worker；新 Boot 发放凭据时锁的是 `supervisor_hosts`。必须覆盖“握手已通过、
凭据随后被新 Boot 撤销、旧注册才到达”的时序。
注册应和 Boot 发放复用同一 Host 行锁，并在事务内重新检查当前 Boot 授权，
再按固定顺序处理 Worker 和连接。不能因为一个旧握手先认证成功，就让它反过来
隔离新 Boot。这是拟议改动必须验证的竞态，不宣称线上已发生过。

**迟到消息与重试分类。** 旧 connectionId、旧 transportId、旧登记确认永远不能
恢复领取或续管理心跳。有效 Boot 仅因连接超时而收到拒绝时，应关闭旧传输并走
现有退避重连；认证失败、Boot 撤销和真正的执行隔离仍然不可重试。
不能把所有 `1008` 或 `stale_connection` 一律改成重试，也不能只改清扫器而遗漏
心跳和重复注册入口对同一超时的处理。

相关代码：[Session 租约](../../packages/runtime-core/src/session-lease-coordinator.ts)、
[领取结算](../../packages/runtime-core/src/run-executor.ts)、
[Boot 发放与认证](../../packages/control-plane/src/supervisor-boot-provisioner.ts)、
[Worker 重连](../../packages/sandbox-supervisor/src/reconnecting-supervisor-websocket-client.ts)。

## 5. 长期失联与实施范围

长期失联的空闲 Boot 可以保留不可派发的身份记录；expired 连接退出 active
超时扫描，不应占用可用容量或反复挤占扫描名额。以后出现新 Boot 或明确撤销，
仍由既有隔离、退役流程处理。不把删除身份记录当成进程已停止的证明，也不以
管理心跳缺失销毁 VM、释放配额或重放工具。

一个完整实施切片包括连接状态/schema、注册与清扫的共同判定、领取最终条件、
可用性查询、错误重试分类，以及以下验证。协议如有变化，在 ADR 中固定；匹配升级不保留旧
运行语义的兼容分支。控制面单独发布入口、dispatch 接单窗口和交互连接接管属于
后续独立切片，不顺便引入版本 Topic 或查询微服务。

## 6. 验收标准

1. 控制面停机 60 秒和 90 秒后，空闲及忙碌 Worker 的进程/Boot 都保持不变，
   管理 connectionId 更新；空闲 Worker 可以领取新 Run，原 Run/租约/VM 继续。
2. 注册先于清扫、清扫先于注册、迟到心跳、重复登记、登记 ACK 丢失均覆盖；
   旧消息不能重开旧连接或影响新连接。
3. 实际 PG 并发事务覆盖在途领取与过期、旧 Boot 握手与新 Boot 发放；等待锁后
   重新判断，不产生重复领取、半条租约或旧 Boot 反向隔离新 Boot。
4. 存在过期未释放租约时，仍按原封口恢复规则处理；撤销凭据和已失败 Boot 不能
   借此复活，unsafe Tool 不自动重放。
5. 只有连接过期可以退避重连，终止授权仍退出；长期离线连接不计入可用容量，
   不阻塞清扫，不触发无依据的 VM 清理。
6. 更新现有网关、Boot、领取、重连测试，再扩展完全停机验收；记录 SIGTERM 与
   SIGKILL 的结果。没有完成的接单窗口、workflow/终端/预览测试继续显式列为边界。

## 7. 成熟机制与取舍

Kubernetes 已提供 Pod 替换、优雅退出和失败后的重启，不需要自己实现部署调度。
正常停止先发 TERM，宽限结束后才 KILL；强制删除 Pod 元数据不等于节点已经
确认旧进程退出。[官方 Pod 生命周期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
及 [Deployment 策略](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#strategy)。

把连接存活与服务/执行健康分开也有成熟先例：gRPC 文档明确区分 keepalive 与
health checking。这里借鉴边界，不替换现有 WebSocket 技术栈。
[官方 keepalive 说明](https://grpc.io/docs/guides/keepalive/)。

领取与过期利用现有 PostgreSQL 冲突行锁和事务，而非另建分布式锁。`FOR SHARE`
与 `FOR UPDATE` 互斥，事务结束释放；实现需统一锁序并测试等待后的检查。
[PostgreSQL 17 显式锁文档](https://www.postgresql.org/docs/17/explicit-locking.html)。

代价是需要认真区分“旧连接结束”和“执行权撤销”，不能靠调大超时掩盖问题。
收益是一次短暂停机不再迫使没有执行权需要清理的空闲 Worker 重启；已有租约、
Kafka writer fencing 和 Cube 外部副作用边界保持独立。
