# 控制面完全停机与重连验证

2026-10-14。运行版本保持 `session-work-6ac697f9`，schema 188、execution-topic v16、
boot reply v3；源码基线 `92ac0068`。本次只新增验收脚本和证据，没有改变运行协议、
租约参数、重连策略或部署镜像。没有实现新的发布入口、版本 Topic 或查询微服务。

## 验证方法

确认没有无关的活跃 Run、VM、开发机和终端后，创建独立测试租户与 Workspace，
使用 GPT-6 Luna 执行两个顺序 Bash：第一个写入开始标记，等待 30 秒并写入完成
标记；第二个只有拿到第一个结果后才能调用，再写一条不同的完成标记。

第一条 Bash 已执行后，将控制面缩到零副本，确认所有控制面 Pod 均已消失且
服务不可达，持续观察至少 60 秒。Worker、PG、Kafka、Cube 和模型代理均未主动
停止。测试客户端同时以同一个幂等 ID 重试另一条新会话请求。

停机期间，每 10 秒通过 PG 观察原 Run 的租约；通过 Worker Pod 内的独立只读
Kafka 客户端读取该 Session 的记录；通过 Cube 原生全节点清单确认原 VM 仍在。
诊断消费者使用手动分配、关闭 offset 自动提交，不加入 Projector 消费组，也
不派发任何工具。报告只保留计数、身份和时间，不保存模型正文、工具参数或凭据。

恢复同一 Deployment 的原副本数后，核对原 Run、Worker 进程、Session 租约和
物理 VM 身份、最终文件标记，以及新请求实际创建的 Run 数量。退出路径会恢复
副本数，另有独立进程作为恢复保护；Deployment 身份或模板被其他操作者修改时，
保护程序拒绝覆盖。恢复保护的 7 项测试包括调用者退出后的独立进程恢复。

## 实测结果

第二轮完整验收通过，且资源清理通过。

| 项目 | 观察结果 |
| --- | --- |
| 停止旧控制面到全部 Pod 消失 | 2.997 秒 |
| 确认零 Pod 后保持不可达 | 65.273 秒，包含末尾只读取证时间 |
| 请求恢复副本到 `/health/ready` 成功 | 9.132 秒 |
| 控制面就绪后新请求确认 | 约 0.140 秒 |
| 新 Run 入库到 Worker 领取 | 5.061 秒，未进一步归因重连、唤醒和领取各阶段 |
| 原 Run | 同一 Run、Worker 进程、Session 租约及 fencing；最终 completed |
| 原租约 | 停机期间继续刷新，约每 20 秒一次；没有过期或因管理断线封口 |
| 原 Worker 管理连接 | 新控制面就绪约 4.56 秒后，以原 boot 身份重新注册，后续心跳保持 active |
| 日志 | PG 投影停在 native seq 10，Kafka 已有 seq 20，含第一个 Tool Result 和两次 Bash 意图 |
| 探针 | Kafka 中仍有 3 条该 Run 的 path probe；没有把缺失回声当成 VM 死亡 |
| 新请求 | 测试客户端失败 29 次后成功，始终同一幂等 ID；再次重试返回原 Run，PG 只有一条新 Run |
| Bash | 两个工具均 completed；最终文件的开始、第一次完成、第二次完成标记各一条 |
| VM | 原 Cube Sandbox ID 和 PiCloud 运行时身份保持不变；仅控制器 owner 换成新实例 |
| 清理 | 两个会话、Workspace、测试租户及其凭据均清理；全局未完成 Run、活跃 writer、VM、待清理 Workspace 均为 0 |

65 秒是故意施加的停机窗口，不能把它当成正常升级耗时。停止与拉起两段合计约
12.1 秒，也只是本机、已备妥同版本镜像的一次观察，不是最坏停机承诺。

新请求的连续重试由本次验收脚本发起，证明服务端幂等与恢复后的领取能力，
不代表所有浏览器 POST 请求已经自动重试。默认前端的草稿/确认语义没有改动。

## 发现的边界

持有测试 Run 的 Worker 没有重启。另一个空闲 Worker 的管理重连遭拒绝，日志
记录 `registration_connection_closed`、关闭码 1008，随后容器重启一次并恢复。
随后只读取证确认：该 Boot 的 `worker_retirements.reason` 是 `heartbeat_timeout`，
退役已完成，原管理连接也是以此原因被 fenced。当前连接过期后，只有存在新鲜
执行租约才会保护原 Worker。它没有影响原 Run，但不能据此宣称所有 Worker
都会在长停机后原地重连。[后续研究方案](idle-worker-reconnect-plan-20261014.md)
区分连接过期与空闲 Boot 退役，尚未实施，不放松真正过期 writer 的 fencing。

第一轮脚本已观察到续租与 Kafka 进度，但未完成验收：它错误地用 PiCloud 的
派生 runtime UUID 匹配 Cube 原生 Sandbox ID，并将 API 客户端的网络错误
`status=0` 排除在可重试错误外。纠正测试代码后重跑，未修改运行时来让测试通过。
第一轮同样恢复了服务并完成测试资源清理。

本次未覆盖：

- 工具 dispatch offset 已提交、Cube 接单确认仍在途的切换窗口。
- 交互式 workflow、终端、预览长连接的跨控制面接管。
- 多控制面副本中，仍存活的实例缓存了已退出 owner 地址的情况。
- 不同应用/协议/schema 版本的混合更新，以及持续多小时或多节点故障。

这些需要独立的验收，不能从普通 Bash 和同版本单控制面恢复推导通过。

## 重现

```sh
npx vitest run scripts/lib/owned-control-plane-outage.test.mjs
PI_CLOUD_LIVE_CONTROL_PLANE_OUTAGE_CHECK=1 node --import tsx scripts/run-live-control-plane-outage-check.mjs /private/control-plane-outage.json
```

默认保持零副本 60 秒，`PI_CLOUD_CONTROL_PLANE_OUTAGE_MS` 允许 45–90 秒。
脚本拒绝已有 VM、无关活跃工作和由 HPA 管理的控制面；恢复收据写在报告旁。
每次使用新的报告路径，避免覆盖尚未处理的恢复收据。

本机私有原始证据：`/tmp/pi-cloud-control-plane-outage-20261014-2.json` 及对应日志；
首轮失败证据为不带 `-2` 的同名文件。临时测试资源已删除，原账户配置保留。
