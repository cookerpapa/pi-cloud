# Direct Steer 恢复验收

日期：2026-09-30。应用实现与部署版本：`2659ba9c425123475b4e01e3845bd66aaf74e4fa`。
真实验收脚本版本：`a1349a1373143808c5eff673e55769f77755817a`。
依据：[ADR-0203](../adr/0203-consumption-confirmed-direct-steer.md)。

## 行为与边界

直接 Steer 与排队消息转 Steer 共用一套持久化、投递和消费确认机制。
接受直接 Steer 时，在同一 PG 事务内创建源 Turn/Run 和控制请求，并暂缓源 Run
执行。文本和附件由 Turn 保存，控制请求只保存引用。源输入按接受顺序预留排队位置，
继承当前目标 Run 已冻结的模型、凭据、环境、工具权限和工作目录。

Worker 的 HTTP 确认只把控制请求改成 `acknowledged`。原生 user Entry 投影后才
确认消费并移除源排队项；目标 Run 封口且没有该 Entry 才恢复排队。回复丢失、
投影延迟、API 重启或迟到的 HTTP 回复不能让两个路径同时执行。新的源 Run
仍需满足原有 Lane readiness 和 Session 故障恢复条件，不恢复旧 Run 的执行。

直接接口现在返回 HTTP 202、`state: accepted`，包含目标和源 Run/Turn ID；
移除旧 `delivered` / `deliveredAt` 返回。网页显示等待消费的输入，丢失接受回复后
重试复用原幂等键。恢复排队后可编辑、取消或重新排序。原先独立的直接投递与
恢复逻辑已删除，Pi Agent Loop、Kafka 协议和数据库 schema 未改。

## 自动化验证

共 **437 项不同的相关测试通过**，重复的定向复验不重复计数。

| 范围 | 通过数 | 主要检查 |
| --- | ---: | --- |
| 独立真实 PG：pending inputs、Steer FK、uploads | 32 | 原子接受、并发幂等、未消费回队、消费后不重复、迟到回复、取消、容量、附件、tenant/viewer |
| 原子 Worker admission、Workspace admission、公开会话 API | 62 | 共用 Session 锁改动、领取、资源和权限回归 |
| 独立真实 PG：Run queue authority | 12 | 同 Lane 顺序、取消、封口与恢复 |
| CloudAgentRuntime 与 Pi Runner | 85 | 原生输入边界、上下文、故障与取消 |
| Protocol | 100 | 新接受响应、请求边界与既有协议 |
| Web UI | 146 | 既有 API、状态与展示回归 |

Chrome/React 展示验收通过：模拟已接受但回复丢失，连续两次提交复用同一键，
队列只有一条 `steering` 输入，失败保留草稿，重试成功后刷新队列并清空已提交草稿。
原有 Workspace、附件、运行状态和导航展示验收继续通过。

Control Plane、Protocol、Web 类型检查，Web 构建，格式、文档与镜像依赖/上下文
检查通过。故障清单增加六个直接 Steer 场景，其断言均包含在上述真实 PG 测试中；
本轮没有重新运行完整的 104 项故障矩阵或宣称全仓 CI 验证。

## 真实 GPT-6 Luna / Cube 验收

[机器记录](direct-steer-live-20260930.json)记录三种场景。每次先让真实 Bash 写入
一次见证文件并等待，再确认 Steer 已获 Worker ACK、尚未进入原生日志。

| 场景 | 目标 Run | 源 Run | 验证结果 |
| --- | --- | --- | --- |
| 正常消费 | completed | cancelled，未启动 | Steer 在目标内消费并得到回答；源排队项退出，未另行执行 |
| Worker 突然退出并重启 | failed / assignment_lost | completed | 封口后自动恢复，新的 Run 回答原 Steer；原 Bash 未重跑 |
| 用户停止 | cancelled | cancelled，未启动 | Pi 在取消收尾时写入 Steer；消息保留在历史，不重复排队或额外请求模型 |

消费的判据是原生 user Entry，不是模型已经回答。真实取消可与 Pi 的队列消费竞争：
本次观察到消息进入历史后停止，因此没有给出该指令的模型答复。独立 PG 测试另外
验证了取消时未消费的分支会回队，并可单独删除。验收脚本按这两种合法结果检查；
没有为了让取消必定回队而修改原生 Loop。

所有场景的原始见证文件均只有一行，目标封口后的同键重试仍返回同一个源输入。
这些是在一台主机上验证的具体故障结果，不是任意外部副作用的 exactly-once 承诺。

## 部署与清理

[部署核对](direct-steer-rollout-20260930.json)确认 Control Plane、两个 Worker、Web
均为上述应用版本且健康。Tool Broker 和已有开发机未重启。Guest 身份仍为
`c4d974ffa0aac9e857876b1ff2668b88c217761c`，不需要模板或 schema 迁移。

部署前无活动 Run、未封口输出和旧版待处理 Steer。部署前已有的 **1,561 条原生日志**
按 tenant/Session/sequence 和 payload 摘要逐条核对，全部保持原样。
两次验收使用的独立测试 Workspace 已实际清理、测试会话归档、凭据撤销；
没有活动 Run 或未封口输出遗留。隔离测试 PG 容器已停止并自动删除。
测试会话的历史审计记录保留，不声称物理删除了这些原生日志。

复验入口：

```bash
# 两个 PG 环境变量指向可创建/删除测试数据库的独立 PostgreSQL。
npm test --workspace @pi-cloud/control-plane -- queued-inputs.test.ts steer-admission.postgres.test.ts workspace-uploads.postgres.test.ts
node scripts/run-browser-presentation-check.mjs
PI_CLOUD_LIVE_DIRECT_STEER_CHECK=1 node --import tsx scripts/run-live-direct-steer-check.mjs
```

真实检查会创建自己的资源，使用 GPT-6 Luna，并在确认没有其他活动输入后对
承载测试 Run 的 Worker 注入退出故障；最终恢复 Worker 并清理自己的资源。
