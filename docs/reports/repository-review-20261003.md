# 全仓架构与实现审查（2026-10-03）

基线：`4294c759`，Pi SDK `0.84.1`，schema 168，Kafka Session log v13。
状态：审查完成。以下内容记录 `4294c759` 的发现；后续获批修复见
[修复与验证记录](review-repair-20261003.md)，不应将本报告当作修复后代码的当前状态。
范围和证据见 [覆盖清单](repository-review-20261003-coverage.json)、
[复现结果](repository-review-20261003-probes.json) 与文末的独立复现脚本。

## 结论

现有主干值得保留：原生 Pi Agent 执行循环，PG 管控制权威，同 Session Kafka 顺序负责可靠发布，
Projector 统一历史、展示和 Tool 路由，Cube 承担外部执行，Volume/S3 分别拥有 Workspace 和不可变图片。
没有发现足以支持推翻这套主干的证据。

但“有序传播 + 内存视图”还没有贯穿成本边界。部分可丢弃展示仍在阻塞有序处理，某些查询虽然只有一次往返，
却取回整个队列或全部 Lane；上传已经流式化，后续图片准备仍把整个原图装进控制面。
下一步应优先消除这些具体放大项，而不是增加另一套缓存、消息队列或调度器。

本次确认三个行为问题、四个优化方向、三个架构取舍。R03 是行为缺陷，O03 是成本/容量问题，D03 是待讨论的部署和职责边界。
没有在这次审查中证明 P0/P1 故障；这不等于证明所有故障场景安全。

## 覆盖方式与边界

盘点基线的 1,396 个受 Git 管理文件和全部 22 个 workspace；对 360 个非 migration 的生产 TS/TSX 文件
建立 AST 导入、查询调用、定时器和体量清单。再按下面的边界阅读实现、调用方和测试，复核先前修复，运行全仓检查与独立探针。
这是全仓范围的风险审查，**不声称对每一行代码完成形式化证明**。AST 中的查询方法数量也不是 SQL 往返实测值。
历史 migration 用于解释 schema 的形成，不能当作当前服务拓扑。

| 审查面 | 涉及 workspace | 核对重点 |
| --- | --- | --- |
| 公共协议和数据库 | domain、protocol、database | 状态机、资源策略、输入/图片边界、事务与通知、当前 schema |
| 发布和恢复 | event-log、runtime-core、pi-session-postgres | 单 writer、封口、Kafka fencing、dispatch commit、重放、精确原生日志、查询量 |
| Agent 和模型 | sandbox-supervisor、supervisor-host、fake-model-server | Pi 校验/hook、工具意图、最终结果、retry/compaction、取消、并发许可、模型代理 |
| 协作和控制 API | control-plane、subagent-control | Run/队列准入、Steer 消费、Subagent Lane、owner 视图、删除、GitLab 同步 |
| 执行和字节 | sandbox-control、tool-sandbox、cube-completion、workspace-runtime、session-attachments | VM 探测/隔离/清理、共享 VM 范围、原生 Tool 回包、上传、图片与 Volume |
| 人类访问和出站 | ssh-gateway、cube-api-authorizer、cube-egress-gateway、provider-egress-relay | 一次性授权、执行凭据边界、目标解析和连接取消 |
| 展示和运维 | web-ui、observability，以及 scripts/deploy/docs | SSE 分帧/重连、队列/附件交互、日志与指标、K3s 发现、Cube 发布契约 |

本次没有支付模型请求，没有对生产 PG/Kafka/Cube 注入故障，也没有重新执行物理多节点 HA 验收或重新编译 Cube 的 Rust/Go 补丁。
Oct 2 的 R02-01–04 及已接受 O02 切片均已在 ADR-0213 中部署，不重复列作未修复问题。
此前真实模型、浏览器和故障验收仅作为有明确版本的历史证据。

## 已确认的行为问题

### R03-01 / P2：S3 流式上传缺少停滞和回执截止时间

位置：[S3ImageBlobStore.putStream](../../packages/session-attachments/src/s3.ts#L65)、
[图片上传](../../packages/session-attachments/src/store.ts#L146)、
[上传 claim 续期与双写等待](../../packages/control-plane/src/workspace-upload-service.ts#L218)。

场景：Workspace 写入成功，S3 已读完请求体，但对象存储迟迟不返回 HTTP 确认。`putStream` 只有调用方 AbortSignal，
没有像 Workspace 的 [uploadHttp](../../packages/sandbox-control/src/upload-http.ts) 那样设置进度/回执计时器。
输入流 EOF 后，`verifiedUpload` 的“等待下一个输入块”计时器也已经结束。
上传服务继续等待 `Promise.allSettled`，每 30 秒续期 claim；同一 upload ID 的重试会继续遇到“正在上传”。

**复现**：本地 HTTP 服务完整接收 1,024 bytes 后不回响应，真实 S3 SDK/适配器在 65 秒后仍 pending；主动取消才返回 AbortError。
同时检查了所安装 Smithy HTTP handler，未配置的 request/socket timeout 不会提供这条链路需要的截止时间。
这证明 S3 分支没有自己的停滞恢复；没有用一次 65 秒观察声称任何网络环境都能无限保持连接。

建议：复用上传端已有的“持续有进展则继续、停滞或回执超时才失败”语义，错误后取消并等待两个分支退出，再结束 claim。
不要恢复总上传时长或文件大小的产品上限。验收应同时覆盖长时间持续传输、EOF 后无回执、取消和相同 ID 重试。

### R03-02 / P2：取消任务的到期与领取仍取 Worker 本地时钟

位置：[Worker 候选过滤](../../packages/supervisor-host/src/postgres-pi-worker.ts#L376)、
[RunCancellationExecutor 领取](../../packages/runtime-core/src/run-cancellation-executor.ts#L318)、
同文件的失败重试期限。

Session lease 已以 PG 时间判断，但取消路径仍用 `new Date()`/注入的 `clock` 比较 `available_at`，并据此计算领取和重试期限。
这不是单纯的 UI 时间戳。Worker 时钟落后时，即使 PG 中的取消已到期，也会迟迟不调用当前 Agent 的取消入口。

**复现**：真实隔离 PG、真实 Run/lease admission、受控 Agent backend。PG 确认有一条到期请求；
取消 executor 时钟落后 60 秒时返回 `idle`，backend 调用为 0；同一请求换成正常时钟立即完成取消，backend 调用为 1。
这没有证明重复执行或 lease fencing 被绕过；确认的是取消时效依赖机器间时钟。

建议：候选过滤和锁内最终领取都使用 PG 时间；领取/重试期限在同一权威时钟上计算。
保留 Run 精确路由、领取互斥、attempt/CAS 和执行退出/封口证明；取消投递的重试计数不是 RunAttempt。
验收增加正负时钟偏差、并发领取和取消完成竞态。

### R03-03 / P3：自定义验证提醒会沿用后续编辑之前的成功

位置：[PiSettlementGateController.observe](../../packages/sandbox-supervisor/src/pi-settlement-gate.ts#L77)。

这是显式配置 `settlement-gate` 才启用的一次性提醒，默认关闭，也不是能保证测试通过的硬门禁。
当前 `#verificationSucceeded` 在一次验证成功后永久为 true，后续 write/edit 不会使它失效。
例如 Agent 先执行 `npm test`，然后修改 `app.ts`，最后结束，配置的验证提醒不会再出现。

**复现**：用控制器的真实事件入口依次输入“验证成功 → 编辑成功 → assistant stop”，`prepareFollowUp()` 返回空。

建议：用当前修改代次和验证覆盖代次表示有效性，而不是整轮永久成功布尔值；保持最多一次提醒和 Pi follow-up 语义。
测试应包括验证后的编辑、并行工具完成顺序、同轮不同 assistant 响应复用 Tool call ID。
这项优先级低于上传、取消和主链路成本，不宜扩展成自建工作流或质量评判系统。

## 更符合当前架构的实现方式

### O03-01：输入队列的展示刷新不应处在有序投影的等待链上

位置：[控制变更消费](../../packages/control-plane/src/main.ts#L260)、
[Projector handler](../../packages/runtime-core/src/session-projector.ts#L169)、
[InputQueueView](../../packages/control-plane/src/input-queue-view.ts#L33)、
[readInputQueue](../../packages/control-plane/src/input-queue-snapshot.ts#L17)。

当前是 `Kafka control_change → await readInputQueue → 序列化/发布 → 记录处理位置`。
异常会被 catch 并触发 resync，**慢查询仍然被 await**。因此某个正在被观察的会话队列会拖住同分区后续记录；
其他分区可独立处理，但仍共用进程和 PG pool。它不应与必须有序安装的 Tool binding 放在相同等待边界。

缓存只有被观察队列，能跳过已经覆盖的 revision，且 SSE 已做分帧和最新值合并；这些优化有效。
剩余问题是每次必要刷新都取完整文本/附件列表，64 MiB 限制发生在整个结果读回和序列化之后，超限结果仍会发布。
分帧解决单帧限制，不解决完整快照的读放大。

隔离 PG 中，每条输入 4,096 个 ASCII 字符，仅执行真实队列查询：

| 排队输入 | 单次 JSON 快照 bytes | 单次读取样本 |
| ---: | ---: | ---: |
| 10 | 42,926 | 4.94 ms |
| 100 | 428,309 | 12.30 ms |
| 500 | 2,141,510 | 52.01 ms |

时间是与其他隔离测试同时运行的单次观察，不能当作吞吐基准；返回大小和行数是更可靠的证据。
若每次变更都触发一次未被 revision 合并覆盖的刷新，连续加入 N 条输入会产生累计 O(N²) 的返回数据；
并非声称所有突发请求都无法合并。

建议分两步：先在同 owner 进程内进行有界、按 Session 合并的异步展示刷新，Projector 只发失效/刷新提示；
保留 generation、revision、丢提示后的快照恢复。再设计队列分页或有界摘要，编辑某条消息时按需取内容。
不增加 consumer group，不移动实际输入消费权威，也不把大段用户文本复制到控制引用里。

### O03-02：一次 native append 不必读全部历史 Lane head

位置：[projectNativeSessionAppend](../../packages/pi-session-postgres/src/project-native-session-append.ts#L34)。

锁定物理 Session 后，context 查询通过 `jsonb_agg` 取该 Session 所有 Lane head，即使本次只写一个 name fact。
Lane 元数据是历史的一部分；已结束的子任务不意味着 Lane 可以删除。取消树上限后，这种成本更值得关注。

复现调用真实投影函数，每次仅一个 name fact；合成 Lane 只用于隔离测量：

| 已存 Lane 数 | 本次实际返回 Lane head 数 | Lane head JSON bytes |
| ---: | ---: | ---: |
| 1 | 1 | 32 |
| 101 | 101 | 4,124 |
| 1,001 | 1,001 | 41,925 |
| 10,001 | 10,001 | 428,926 |

这不是多一次 SQL，而是每次 SQL 都带回无关数据。建议先按 append 涉及的 Lane 集合限定读取，name/label-only 按需跳过；
保留 Session 行锁后的新快照、序号连续性、append 幂等和 parent 检查。
这里不需要新增 Kafka Lane 消息或第二套持久投影，更不应为了省查询删除最终一致性检查。

### O03-03：把图片原始字节也保持为流，避免控制面成为图片内存中转站

位置：[prepareInputImages](../../packages/sandbox-control/src/sandbox-controller.ts#L1956)、
[S3 get](../../packages/session-attachments/src/s3.ts#L90)、
[Cube prepareInputImage](../../packages/sandbox-control/src/cubesandbox-sandbox-provider.ts#L1683)。

当前路径是 `S3 → 全部 chunk + Buffer.concat → Control Plane Buffer → 上传 Cube 临时文件 → 归一化 → 不可变附件`。
上传阶段虽无整文件缓存，发送给模型之前仍会重新读出完整原图；缓存 chunk 与合并 Buffer 还会有同时存活的阶段。

图片准备已有单并发和等待容量，附件存储也有 128 MiB 的在途预算；不能说完全没有控制。
但该预算明确允许一个超预算对象单独通过，而且不负责返回后的 Buffer 生命周期。
所以它不是原图大小独立的内存保证。大图可能增加承载 API、ingress、Projector 的同一进程的内存和 GC 压力。
**本次没有制造生产 OOM，也未测出具体 OOM 阈值。**

建议在现有存储/Provider port 上提供带长度、哈希和取消的流读取，把原图流送现有 Cube 临时文件通道，仍在 Cube 归一化。
最终提供给 Pi 的正常 ImageContent 仍需要字节，并不承诺模型上下文零内存；目标是移除控制面对任意大小原图的整块持有。
不恢复上传大小配额，不更换对象存储，不直接向 guest 暴露长期 S3 凭据。

### O03-04：取消通知可以进一步限定唤醒范围，但不要直接删除补扫

位置：[PostgresPiWorker 主循环](../../packages/supervisor-host/src/postgres-pi-worker.ts#L270)、
[取消扫描](../../packages/supervisor-host/src/postgres-pi-worker.ts#L353)。

Worker 仍以一秒为默认补扫间隔，在有 active Run 时检查取消候选，通用 Run queue 通知也会唤醒这条路径。
这不同于已优化的 Outbox 空闲轮询。无需把它描述成严重瓶颈：本轮没有做大规模 Worker 数的定量测试。

先测活跃但无取消的 Worker 每秒负查询和全局通知放大；有收益再利用现有 PG 通知或同 Session 控制引用标记已知待取消 Run，
到期重试由本地时间调度唤醒、PG 时间最终判断。丢提示、重连和接管仍需要当前 PG 快照/低频补扫。
不能让“内存里没有取消”成为永久不查数据库的理由。

## 需要讨论的架构取舍

### D03-01：Cube 的部署期望状态仍由 Helm 和后置 patch 共同组成

位置：[Cube 安装器](../../scripts/install-cubesandbox-k3s.mjs#L1261)、
[POSIX 挂载/配置安装](../../scripts/install-cubesandbox-k3s.mjs#L514)。

当前完整安装器是受支持路径；它先 Helm upgrade，随后修改配置、挂载等。最新发布 guard 能阻止不匹配部署继续上线，
但尚未把 Cube 镜像、挂载和配置变成同一次声明式渲染的结果。

这已有真实证据：[最近验收](unlimited-quotas-20261003.md#findings-repaired-during-acceptance) 中，单独的资源 Helm 升级
覆盖了共享路径、配置挂载和 Cubelet 补丁版本。现网已经恢复，**不是声称当前仍然坏着**。
架构风险在于两个阶段之间的中间状态，以及常规 Helm 操作与项目后置步骤之间的耦合。

倾向：把必要 overlay 放进同一 chart 渲染或受维护的 post-render 阶段；版本/挂载 guard 继续保留。
验收要证明单次渲染包含最终期望状态、重复部署不漂移、失败回滚一致。先讨论维护方式，不直接换掉部署体系。

### D03-02：Pi 的对齐较好，Cube 侧已经是必须长期维护的定制接口

[runtime-build.json](../../deploy/cubesandbox/runtime-build.json) 固定四个补丁，补丁文件合计 8,585 行，
包括测试、生成代码和 diff 上下文，**不能当作 8,585 行手写运行代码**。
它们涉及观测、Tool 接管、boot/scope fencing、停止、回包和探针，已超出普通 SDK 参数适配。
[Cubelet 镜像](../../deploy/cubesandbox/Dockerfile.cubelet) 还打包 completion 适配器及多个 PiCloud 包。

去掉独立 Broker 是合理的：进程生杀和已接纳 Tool 的生命周期由离进程最近的 Cubelet 管理。
但这些职责并没有消失；升级 Cube 必须维护这一接口集合，并与 guest/completion 契约成套验证。
普通任意 shell 也因此仍不能宣称 exactly-once 或跨 Cube boot 自动恢复。

倾向：保留当前已验证行为，明确区分上游 Cube、PiCloud native patch、completion 和 guest 的发布输入；
继续缩小传递依赖，把补丁做成可测试、可移植、可回滚的接口边界，评估适合上游化的部分。
不要重新造 Broker，也不要用未经验证的原版 Cube 静默替换。

### D03-03：Control Plane 合进一个进程有合理性，也有真实的资源干扰范围

API、publication ingress、Projector、VM 生命周期及一些附件/展示工作位于同一进程，
[main](../../packages/control-plane/src/main.ts#L128) 还复用一个 12 连接的业务 PG pool。
它减少跨服务往返，也使 owner、封口和内存视图易于保持一致；代价是图片、队列、CPU/GC、连接等待会影响其它职责。

目前没有证据支持立即拆成多个部署单元。更小的先手是 O03-01/03、明确不同任务的并发和取消预算、量出各阶段排队时间；
再判断是否需要进程隔离。即使拆，Session publication 与 partition ownership 的一致性也必须保留，不能拆出第二个执行权威。

同一 Session 的 Lane 共享 Worker/writer，以及同一分区的有序处理，属于有意的耦合。它换来了相对简单的上下文和封口语义。
Projector 遇到不能跳过的持久投影错误仍会阻塞相应分区；不能靠跳 offset 或重放 shell “修复”。
若未来确实需要跨 Lane 独立容灾，再用实测需求讨论协议，不凭抽象的“低耦合”删除现有边界。

## 对齐 Pi 的结论

- `CloudAgentRuntime` 创建的是 Pi `Agent`；参数准备、schema 校验、before/after Tool hook 和工具调度由固定 Pi 版本执行。
  云端包装在原生校验之后，把 `tool_started` 与命令合并持久化；回包经 Pi 处理后才写 canonical Tool Result。
  `operationId`/结果 Entry 身份与原生 Tool call ID 各有范围，没有把 Tool call ID 当整轮全局唯一。
- 高层恢复、存储、租约、模型许可、world state 和云端输入消费由外层运行时提供，属于合理职责。
  本地 Pi 0.84.1 的 `AgentHarness.prompt/resume/steer` 仍明确抛出未实现错误；不能因为接口同名就建议机械替换整个外层运行时。
- 活跃路径走内存 native view，冷启动读最新 compaction 与有效 suffix；不是每轮全量加载 lifetime JSONL。
  PG 原生日志投影与 Workspace Volume 的职责明确，不建议恢复已删除的 Entry/Record 副本或每 Run archive。
- 观察心跳与 lease 不混为一谈。缺失探针不授权销毁；共享 VM 的隔离按记录物理身份关闭绑定，普通 Tool error 不等于整台 VM 损坏。
  管理面物理证据和执行链证据应继续分开使用。

局部命名仍有 `toolBrokerProtocolVersion` 和旧 Broker 注释，但不能由这些名字推出存在独立 Broker 服务。
将来改对应协议时统一更名即可，不值得本次为清理词汇制造兼容层或强制 wire 升级。

## 哪些读适合内存，哪些应继续查 PG

| 读/操作 | 当前或建议的方式 | 必须守住的边界 |
| --- | --- | --- |
| 普通 Worker append | 已安装 publication scope，热路径无 SQL | grant 安装、替换 owner、关闭 admission、同队列 seal |
| Tool/probe binding 路由 | 已有 owner 内存视图，保留 | 当前关闭的同步 barrier 与 Cube 原生 scope fencing |
| 队列展示 | revision 提示 + 合并刷新/分页 | 展示不阻塞有序执行；真正输入消费仍看 PG 和原生消费记录 |
| Subagent 状态/目录 | 已有版本失效和结果复用 | 子 Run 准入、取消、晚到投递必须重新检查权威 |
| native append parent/head | 先限定本次相关 Lane 的查询集合 | 一次 Session writer、连续 sequence、PG 原子投影 |
| 取消和到期唤醒 | 已知待处理集合/通知可作为提示 | PG 时间、锁内 claim/CAS、冷恢复和丢通知补扫 |
| Preview 权限、删除、quota 释放 | 继续当前 PG/物理证据检查 | 不把延迟 Kafka 视图当撤权或物理不存在证明 |
| 图片 | 同次不可变引用去重已实现；原图传输改流式 | 租户、引用、哈希、reachability/GC 和可取消 I/O |
| 跨 Session 共享资源、平台配置 | 暂不塞入随意一个 Session 分区 | 明确 owner/广播范围后再设计；不能假设全 Kafka 有全局顺序 |

## 验证、文档变更和建议顺序

本轮 `npm run check` 通过全部 workspace 类型检查、1,597 个 workspace 测试和 57 个验收辅助测试，
合计 **1,654 passed、8 skipped**；跳过项需要额外 Kafka 或真实 Cube 设置。
逐包统计和独立脚本结果记录在 [证据 JSON](repository-review-20261003-probes.json)。
文档链接、格式、运行时策略、Helm 和自托管安装器契约检查通过；隔离 PG 容器及其匿名卷已清理。
真实 PG 使用新建的隔离容器，每个探针新建独立数据库并在结束时删除；S3 停滞用本机临时 HTTP 服务。
没有使用生产数据库做这些变更。未开启的 Kafka/真实模型/浏览器集成不计为本轮通过。

复现脚本针对已命名基线，不加入 CI 冒充修复后的回归测试。先启动隔离 PG，并设置 `PI_CLOUD_REVIEW_DATABASE_URL`；
脚本只接受 loopback endpoint，创建随机新数据库，不清空指定 URL 原有数据库。然后从仓库根目录执行：

```bash
node --import tsx docs/reports/repository-review-20261003-probes/data-paths.mjs
node --import tsx docs/reports/repository-review-20261003-probes/cancel-clock.mjs
node --import tsx docs/reports/repository-review-20261003-probes/s3-stall.mjs
node --import tsx docs/reports/repository-review-20261003-probes/settlement-gate.mjs
```

结果写到各脚本注明的 `/tmp/pi-cloud-review-*-result.json`。S3 探针需约 65 秒，只使用测试凭据；
工具/模型 backend 为受控夹具，未执行实际 shell 或请求 LLM。单次耗时不作性能改善承诺。

README 补齐 Worker 本地 Model Gateway、boot-scoped reply 回路、上传/对象存储路径、内存视图的 PG 回读和容量边界。
文档索引纠正了 Oct 2 修复“仍开放”的过时描述；BACKLOG 登记本轮条目，并修正已取消默认子任务上限后的容量措辞。
没有新 ADR，因为本轮没有采纳并实施架构变更。

建议先做 R03-01/02 的独立修复，再做 O03-01/02/03 的端到端切片；R03-03 是小范围可选功能修正。
Cube 声明式发布值得优先讨论；是否拆进程、如何上游化 Cube 扩展需要另行决定。
下一轮用固定工作量验证 SQL 次数、返回 bytes、pool 等待、Kafka 接纳/投影和冷恢复，保持当前可靠性语义。
