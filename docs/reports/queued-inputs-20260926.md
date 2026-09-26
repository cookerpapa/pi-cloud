# 待发消息管理验收

日期：2026-09-26。实现与部署版本：`5b91cd27e01ff7832c9a7246e66e34d082ed3cd3`。
依据：[ADR-0194](../adr/0194-editable-pending-inputs.md)。

## 使用行为

会话输入框上方显示待发消息。每条尚未开始处理的消息支持编辑保存、上下移动、
取消发送，以及直接或编辑后「立即引导」当前任务。开始处理后内容与顺序冻结。
编辑时如果消息已经开始执行或发生并发修改，草稿保留，可以放回输入框继续使用。
Viewer 和委派会话不提供修改操作。

排队消息仍在当前任务结束并完成封口后开始执行。立即引导走 Pi 原生 steer 队列，
在当前模型响应及该批工具完成后、下一次模型请求前消费；不会强行中断运行中的工具。
已提交引导的条目显示确认中的状态，不能继续编辑、移动或撤回。
停止按钮仍只停止当前任务，不清空后续队列。

## 数据与失败边界

- 复用 PG Turns/Runs、Session revision 和现有控制请求表。没有增加调度器，
  没有修改 Pi Agent Loop。文本仍由 Turn 保存，每个会话最多 64 条待发输入。
- 文本与顺序在 Worker 领取时冻结；模型、环境和凭据快照仍在接受输入时冻结。
  Worker 拿到 Run 锁后重新读取文本，避免并发编辑被旧的 SQL 快照覆盖。
- 修改带 revision 与 Idempotency-Key。领取与编辑、取消、排序竞争时，
  返回冲突并保留草稿；重复 HTTP 请求不会再执行一次修改。
- 转为 steer 时，先在同一事务中暂缓原排队 Run 并持久化引导请求。
  重试复用同一原生输入 ID。只有 canonical user Entry 才确认消费并结束源排队项；
  只有目标封口且没有该 Entry 才恢复原位置。单次 HTTP 失败不会触发重复执行。
- 未启动的取消条目保留为审计和去重记录，但不混入已执行会话历史。
  待发列表独立读取，64 条排队消息不会挤掉当前任务所在的历史页。

公共接口为 `GET /v1/sessions/:sessionId/queued-inputs` 和
`POST /v1/sessions/:sessionId/queued-inputs/:turnId/actions`；详细字段见
[Control Plane API](../../packages/control-plane/README.md)。

## 验证

冻结实现版本后，`npm run check` 完整通过：**1,165 项通过，120 项按默认配置跳过**，
所有工作区类型检查通过。跳过的检查包含需显式启用的基础设施集成测试。

- 独立真实 PostgreSQL 上的待发输入测试 **14/14** 通过，覆盖领取与编辑/取消/排序
  竞争、重复控制请求、同目标引导顺序、HTTP 回包丢失、服务重建后的恢复、
  消费与封口判定、关停、32 条以上待确认消息的公平性及历史分页隔离。
- [故障矩阵](queued-inputs-faults-20260926.json) **61/61** 通过，启动时工作树干净；
  新增八项队列相关故障检查。它是确定性故障注入，不是生产故障或多机 HA 实验。
  上述测试有重叠，不与全仓数量相加。
- 浏览器组件验收通过：编辑、排序、取消、编辑后引导、回包丢失时复用幂等键、
  冲突保留草稿、过期读取抑制、读取恢复、Viewer 与移动端显示。
  既有整页展示验收也通过。
- Web 构建、文档、格式、运行策略、镜像依赖闭包与 Compose 配置检查通过。

[真实 gpt-6-luna / Cube / Chrome 验收](queued-inputs-live-20260926.json)：

1. 第一轮执行一次等待 20 秒的 Bash 工具；同时接受 A、B、C、P 四条输入。
2. 在实际网页编辑 A，将 B 上移到 A 前，取消 C，编辑 P 后立即引导第一轮。
3. 实际执行顺序为第一轮、B、编辑后的 A；三个 Run 均完成，启动时间不早于前驱结束。
4. 第一轮回答包含 P 的引导标记。C 和 P 没有 Worker 所有权、没有另行执行；
   P 的终态原因为 `queued_input_steered`。最终历史只有三个实际执行的 Turn。
5. 最后一轮由另一个 Worker 执行。测试会话已归档，Workspace 已标记删除且
   `storage_purged_at` 已确认。浏览器和脚本登录均退出，保留普通测试账户元数据。

## 部署与清理

[部署核对](queued-inputs-rollout-20260926.json)记录本机 Compose 的两个 Worker、
API、Tool Broker 和 Web，五个容器均健康且 revision 为上述实现版本。
关键 API、协议和两个 Worker 的源码 SHA256 与仓库一致。

切换前确认没有未完成 Run、未释放 lease 或未封口 Session，停止应用入口和执行进程，
以 0600 权限保存私有 PostgreSQL 备份，然后应用 migration 152 并启动匹配版本。
备份位于忽略目录 `deploy/production/runtime/pre-queue-152-1790434437673/postgres.dump`，
不进入 Git。PG、Kafka、Provider Gateway 和图片存储没有重启。

Cube guest 构建身份为 `1cddcc613a412340b246127c7011b13fb32288f2`，四种模板已同步。
模板保留流程删除四个旧模板；十一项既有旧节点模板清理失败继续保留在运维 backlog，
没有放松删除保护或据此宣称所有历史资源已清空。
实测清理后，未完成 Run、未释放 lease、未封口 Session、待确认引导均为零。
独立队列测试 PostgreSQL 容器也已删除。

## 复验

```bash
npm run check
node scripts/run-browser-queue-check.mjs
node scripts/run-browser-presentation-check.mjs
```

真实 PG 竞争测试先设置指向专用测试数据库的 `PI_CLOUD_POSTGRES_INTEGRATION_URL`
（需要创建测试数据库权限），再运行：

```bash
npx vitest run packages/control-plane/test/queued-inputs.test.ts --maxWorkers=1
```

故障矩阵还使用 `PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL` 指向专用测试 PG；
设置两项测试数据库变量后运行：

```bash
npm run eval:faults -- --output /tmp/queued-inputs-faults.json
```

下面的验收会调用真实 Luna，创建专用账户和临时 Workspace，并清理自身执行资源：

```bash
PI_CLOUD_LIVE_QUEUE_CHECK=1 node --import tsx scripts/run-live-queue-input-check.mjs
```
