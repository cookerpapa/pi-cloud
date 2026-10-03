# 全仓复审：Pi 对齐、恢复边界与运行开销

Implementation follow-up: [October 4 repairs](review-repair-20261004.md).
The baseline characterization scripts shown below are preserved at commit
`2c2e1310`; current acceptance uses the maintained tests and Cube admission gate.

审查基线：`3dbf49fb53c2faa3ee1a62faa5657f72a126a59d`，2026-10-03。
本轮交付审查结论、复现脚本和文档勘误；没有修改运行时代码、部署或生产数据。
上一轮 R03/O03 修复状态仍以[修复验收](review-repair-20261003.md)为准。

## 结论与优先级

主体架构仍然成立：Pi 拥有循环与工具语义，PG 拥有控制权，Kafka 承接有序发布与恢复，
Cube 拥有已接收工具的执行，Volume 和 S3 分别保存 Workspace 与不可变会话图片。
这轮没有发现需要重新引入独立 Broker、第二套调度器或另一个日志权威的理由。

问题集中在边界没有完全统一：输入的字符预算与实际日志预算不一致，子任务的部分时间判断
仍使用应用时钟，资源回收缺少失败隔离，以及一些验证入口残留旧部署假设。
另一个需要单独讨论的问题是 Cube 封口标记耗尽后的故障范围。

| 编号 | 优先级 | 发现 | 证据性质 |
| --- | --- | --- | --- |
| R2-01 | P2 | 合法的人类输入可以在接收后才因 native 日志大小失败 | 实际 API schema、PG 接收、Pi runtime/writer/ingress 联合复现 |
| R2-02 | P2 | 子 Agent 取消与主管回复仍混用应用时间和 PG 时间 | 实际生产方法、隔离 PG、正负时钟偏差 |
| R2-03 | P2 | 难以删除的资源会阻塞其他资源回收 | 当前迁移后的 PG、实际 reaper、故障删除端口 |
| R2-04 | P2 | Kafka 验证入口仍依赖已废弃 Docker 网络 | 入口调用链、安装清单、当前网络缺失 |
| R2-05 | P3 | 可选验证提醒仍把目录写死为 `/workspace` | 实际提醒生成器复现；默认 recipe 未开启此提醒 |
| R2-06 | P3 | SSH 接受的终端宽度超出下游协议 | 实际 SSH 接口与下游 parser 的边界复现 |
| Q2-01 | 验证缺口 | 默认 PGlite 队列测试可重复失败 | 全仓、单文件、最小两用例和两个 Node 版本 |
| O2-01 | 优化 | 无子任务的普通封口也触发四次全局子任务查询 | 隔离 PG 实测 SQL 模板 |
| D2-01 | 架构讨论 | Cube 封口容量耗尽会永久关闭整个执行管理器 | 从当前两份补丁生成源码，运行 Go 特征测试 |

没有在本轮证明 P0/P1 数据破坏或任意工具重复执行。这个结论不是所有故障场景的安全证明。
建议先处理 R2-01/02/03 和 Q2-01，再做 O2-01；D2-01 需要明确故障隔离与恢复契约后单独实施。

## 覆盖和方法

基线有 1,417 个跟踪文件、22 个工作区、360 个非迁移运行时 TS/TSX 文件，约 97,832 行。
[覆盖清单](repository-review-20261003-r2-coverage.json)记录每个跟踪文件的分类与摘要，以及
TS 导入、异步/查询风险指标。运行时工作区导入图没有发现包级依赖环。

“全仓”指整个清单都纳入审查与分类，并沿关键业务边界人工展开；不表示每一行都经过人工证明。
生成代码、历史迁移和历史报告按其用途核对，不把旧 Cell、Temporal 或 Broker 名称推断为当前拓扑。

| 范围 | 人工展开的边界与验证 |
| --- | --- |
| sandbox-supervisor、supervisor-host | Pi Agent 公共 hooks、校验后工具意图、重试/compaction、失败前缀、输入消费、模型 permit、Worker 接管与取消 |
| runtime-core、event-log | Session ingress、同队列封口、Kafka 事务/dispatch commit、分区换主、投影重放、live tail、SSE、保留水位 |
| pi-session-postgres、database | 单 writer、冷读/compaction、Lane heads、投影锁后快照、PG 时间、取消、读池隔离、迁移和索引 |
| control-plane、subagent-control | 接收/编辑/steer、内存视图版本、子任务清理、删除/重绑、开发机、上传、GitLab 状态同步 |
| sandbox-control、Cube 补丁、部署插件 | 已接收执行与回包、停进程/cgroup、共享 VM 隔离、节点锚定探测、quarantine、Volume 删除凭据 |
| tool-sandbox、workspace-runtime、session-attachments | 原生文件工具、图像处理、流取消/长度/摘要、上传双写收尾、图片引用与 GC |
| web-ui、protocol | 队列分页/草稿、SSE framing、phase、重绑、附件、参数和跨端协议边界；实际 Chromium 队列交互 |
| ssh-gateway、cube-api-authorizer、cube-egress-gateway、provider-egress-relay | SSH/终端转接、凭据与路径边界、网络转发与连接收尾 |
| domain、observability、fake-model-server | 状态/资源策略、观测与权限的分离、故障日志、测试服务与真实服务的区别 |
| scripts、Dockerfile、Helm、CI、维护文档 | 发布来源、标量类型、部署前校验、镜像闭包、旧入口、当前测试结果与历史验收的区别 |

## R2-01：输入接收没有覆盖 native 封装的实际字节预算

位置：[人类输入 schema](../../packages/protocol/src/control-plane-api.ts) 938，
[接收路径](../../packages/control-plane/src/control-plane-store.ts) 1483，
[初始 native checkpoint](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts) 392，
[ingress 大小检查](../../packages/runtime-core/src/session-publication-ingress.ts) 412。

`prompt` 限制字符数；Pi 初始 checkpoint 又在 `originalPrompt`、`initialMessages` 和 user Entry 中
携带文本。JSON 转义后的字节数与字符数不同。子任务已经有 ADR-0204 的编码预算，普通输入尚未统一。

复现使用 100,000 字符、包含可存入 PG 的 U+0001 的文本：HTTP 请求 JSON 是 599,973 字节，
schema 通过，PG 接收并创建 Run；第一个实际 native Fact 是 1,801,283 字节，超过现有
921,600 字节上限。真实 ingress 返回 `size`，模型请求数为零。
PG 中的已接收文本仍存在；这里证明的是“接收成功后，运行才发现无法发布”，不是数据库丢失。

建议把已有传输预算校验放到输入接收和队列编辑的共同边界，考虑最终文本与附件元数据的组合，
保留 Worker/ingress 的最终校验。不要静默截断，也不要用增大 Kafka 包上限掩盖问题。
多附件的组合预算属于同一检查范围，本轮没有声称已跑完任意附件数量的上界。
验收应包括最大普通文本、转义文本、编辑后输入、steer 和附件组合。

## R2-02：子 Agent 的取消生产端与回复截止时间仍未统一

位置：[子任务取消](../../packages/subagent-control/src/postgres-subagent-job-provider.ts) 980、1034，
[主管请求](../../packages/subagent-control/src/postgres-subagent-supervisor-channel.ts) 124、303。

上一轮修正的是取消执行器的领取/重试。子任务取消插入 `turn_control_requests.available_at` 时仍取
`new Date()`。控制面快 60 秒时，取消命令在 PG 看来还要等约 60 秒，Worker 的 PG 时间补扫无法提前执行。
同样，主管请求列表用 PG 判断过期，回复方法却拿 `Date.now()` 判断。

隔离 PG 复现：取消已入表但 `due=false`，剩余约 59.99 秒；快 60 秒的回复端拒绝仍剩 30 秒的请求，
慢 60 秒的回复端接受已经过期 30 秒的请求。
此处时间实验使用缩减关系表隔离判断逻辑，不冒充完整子 Agent 调度验收。

建议这些持久截止时间统一由 PG 生成和锁后判断，本地等待继续用单调时钟。
同包 child ready 的 `available_at` 也使用应用时间，应在同一时间语义切片中核对。
验收加入生产端偏差、锁等待跨越到期点、重复取消和已回复请求的幂等性。

## R2-03：回收失败没有充分隔离

位置：[Workspace reaper](../../packages/sandbox-control/src/workspace-volume-deletion-reaper.ts) 96、124，
[图片 reaper](../../packages/session-attachments/src/store.ts) 271、292。

Workspace 每轮固定选最老的 16 条待删除记录，失败不会改变下次选择顺序。
当这 16 个 Volume 都因 refcount/节点问题持续失败，第 17 个完全可删除的 Workspace 永远轮不到。
复现连续三轮进行了 48 次失败删除，第 17 个获得零次尝试；解除故障后，两轮成功清掉全部 17 个。

图片回收则会在一条 `blobs.delete()` 失败后退出整批。三张图片中只让第一张删除失败，连续三轮
都只尝试同一张，其余两张仍留在 `deleting`，没有得到处理。S3 字节没有被误删。

建议保留当前回收所有权与保护条件，为失败项提供公平重试，并让单项错误不截断其他项。
Workspace 的批次公平性与图片循环的错误隔离要分别验收。
不能通过跳过 refcount、忽略未封口 Run 或把失联当成不存在来“解决”积压。
历史 BACKLOG 中的 stale Volume refcount 是可能触发者，和本轮发现的回收饥饿不是同一个问题。

## R2-04：维护中的验证入口残留 Docker 运行拓扑

位置：[公开 Kafka 压测入口](../../scripts/run-kafka-accepted-fact-load.mjs) 29，
[背压入口](../../scripts/run-kafka-backpressure-check.mjs) 21，
[分区隔离入口](../../scripts/run-kafka-consumer-isolation-check.mjs) 21，
[保留水位入口](../../scripts/run-native-retention-check.mjs) 21。

`npm run eval:kafka-accepted-facts` 仍启动容器并加入 `pi-cloud-production_event-log`。
ADR-0214 的 K3s 安装不再创建该 Docker 网络，当前主机也确认它不存在。
另外三个包装器具有相同遗留假设，外层还没有统一透传内层支持的测试 broker 配置。

这会破坏从当前安装方式复现验证的入口，不等于生产 Kafka 故障。
本轮用隔离 RF3 和现有 `inside` 路径运行了背压、分区隔离和保留水位主体，它们均通过。
建议统一为显式配置的隔离 fixture 或当前 K3s 验证执行方式；删除不再维护的包装器，避免保留旧网络兼容分支。
至少公开 npm 入口要纳入拓扑检查，不能只检查 Helm 模板。

## R2-05：可选验证提醒使用错误的工作目录

位置：[policy 提取与提醒](../../packages/sandbox-supervisor/src/pi-settlement-gate.ts) 41、124。

接受的 Run 可以在 `/home/user/project` 或 `/workspace/repository` 工作。
policy 提取没有带入该目录，提醒却无条件拼出 `/workspace/<recipe.cwd>`。
复现中工作目录是 `/home/user/project`、验证相对目录是 `frontend`，提醒输出 `/workspace/frontend`。
合法的实际绝对目录命令也可能不被识别为已执行验证。

建议从冻结的 Run 工作目录解析 recipe 的相对目录，并复用这一结果做命令识别和提醒。
这是默认未开启的可选提示功能；上一轮验证成功代数的修复仍然有效。

## R2-06：SSH 终端列数的两端约束不一致

位置：[SSH PTY 接收](../../packages/ssh-gateway/src/server.ts) 45、50，
[开发机终端 schema](../../packages/protocol/src/development-environment.ts) 182。

SSH 网关允许并转发最多 1,000 列，开发机 `terminal.open` 协议却最多 512 列；
后续通用 resize 协议又允许 1,000 列。600 列的 PTY 会被 SSH 接受，随后在 Sandbox Control 的 open 校验中拒绝。
应共享同一尺寸定义，并在边界明确处理超出范围的值。
验收同时覆盖初次 open 和后续 window-change，不能只用固定的 80 列模拟终端。

## Q2-01：默认本地测试门禁当前不是绿色

本轮 `npm run check` 的类型检查全部通过；workspace test 输出合计 1,448 通过、11 失败、163 跳过，
因此该命令失败，后面的 helper 测试没有被它执行。helper 单独执行为 63/63 通过。

失败集中于 `control-plane/test/queued-inputs.test.ts` 的 PGlite 路径：先出现 `ECONNRESET`，
后续用例连接失败，`afterAll` 等待 60 秒超时。完整文件复跑重复；缩到“取消后恢复 steer”紧接
“direct Steer 租户/幂等校验”两个用例，也出现前者通过、后者失败。
Node 24.12.0 和部署/CI 锁定的 Node 24.18.0 均复现。

同文件外置 PostgreSQL 路径全部通过。本轮外置 PG 聚焦组共 56/56 通过，另有 Pi backend conformance、
索引/锁后快照/查询组 33/33 通过。GitHub CI 配置使用外置 PG，不能把本地 PGlite 失败写成“已证明 CI 失败”。
尚未定位连接失效的最底层原因，不把它直接归因于生产 DB adapter。
修复目标是让默认本地门禁可靠或明确要求真实 PG，保持并发/取消覆盖，不能用跳过失败用例代替。

## O2-01：把普通封口触发的子任务维护限定到相关范围

位置：[封口触发点](../../packages/control-plane/src/subagent-controller.ts) 384，
[维护扫描](../../packages/control-plane/src/subagent-controller.ts) 432，
[子任务收尾](../../packages/subagent-control/src/postgres-subagent-job-provider.ts) 1046。

即使库里没有任何子任务，一条普通 Session 的 seal 仍会触发四条全局查询：
已结束子 Run、过期 preparation、需要取消的子树、最早 preparation 时间。
当前 change 已携带 Session/Run 身份，而这些维护查询没有使用该范围。
[实测证据](repository-review-20261003-r2-evidence.json)保留了四条 SQL 模板。

建议将正常事件唤醒限定到相关物理 Session/父 Run，利用已有 pending/read views 合并工作；
把全局扫描留给启动恢复、容量溢出和确有需要的兜底。PG 仍负责取消与状态写入。
验收需证明无子任务的普通封口不做无关全局扫描，同时不漏掉父任务封口、过期 preparation 和换主遗留子任务。
不能单纯删除 reaper。

## D2-01：Cube 的容量保护跨越了物理 VM 故障边界

位置：[Cube execution manager 补丁](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch)
5628、5682、5708；叠加当前 0004 补丁后验证。

manager 的 Run/writer/operation 封口集合总量达到 65,536 时，下一次 Stop 会设置进程级 `closed=true`。
这个字段同时代表永久关闭。即使之后确认旧 VM 消失、`ForgetRuntime()` 清空它的全部标记，
`closed` 也不会恢复；新 VM 的工具仍返回 `executor_capacity`。

特征测试对一个 VM 构造 65,537 次独立 scope closure，确认标记从 65,536 降到零后，
`Accepting()` 仍为 false。没有启动或停止任何真实 VM。
长期保留的开发机、多 VM 共用 Cubelet 会使这个边界有实际意义；本轮没有声称生产已达到它。

容量耗尽时拒绝执行，是 ADR-0210 有意保留的正确保护。需要讨论的是：

- 某个 VM 的封口历史是否应该使整台 Cubelet 的新 VM 永久无法执行；
- 容量拒绝与 shutdown 是否应该有独立状态及明确恢复条件；
- 能否按物理 VM/已关闭 writer 收敛证据，同时继续拒绝延迟的旧命令。

倾向于收紧故障范围，并把安全恢复条件做成契约。不能直接删标记、取消内存预算或翻转全局开关，
因为当前全局关闭还保护了未能记录的那条新封口。涉及 Cube admission/fencing 的改变应先补 ADR。

## 回归与开销证据

本轮[结构化证据](repository-review-20261003-r2-evidence.json)记录详细结果。

- 原生 Pi 0.84.1 的 `Agent` 继续拥有循环、参数校验、工具 hooks 和队列消费；没有发现自建第二个 Agent loop。
  `CloudAgentRuntime` 的重试、上下文投影与云端恢复是外层职责。
  当前版本 `AgentHarness.prompt/resume/steer` 仍是未实现入口，不能机械替换成它。
- PG 官方 Session backend conformance 与真实 PG 索引/锁等待检查通过。
  scope 安装、物理 Session writer、dispatch commit 与封口边界应保留。
- 队列 100/500 条、每条 4,096 字符时，第一页分别约 85,781/85,782 字节，全部输入可分页取到。
  10,001 个历史 Lane 下，name Fact 仍返回零个 Lane head。上一轮这两项修复成立。
- Chromium 队列编辑、移动、删除、改后 steer、丢回复、保留草稿、分页冲突和后页编辑通过。
- 完整无 Tool Turn，真实 PG/HTTP/RF3、确定性模型：六次为 142–143 个 SQL client 请求、12 个事务、
  6 个 native rows、9 个 Kafka records，其中 4 个 control references；不能把全部 SQL 都当作冗余。
  SQL 数含事务命令和后台维护。隔离机上端到端约 7.7–8.7 秒，包含测试等待与后台收敛，
  不据此声称生产时延，也不把它归因于 PG 磁盘。早期样本与其他隔离 Kafka 检查有重叠。
- RF3 分区隔离：受阻分区的 513 条记录恢复，另一分区继续推进；重平衡和恢复 floor 检查通过。
  背压：6,000 条尝试中 66 条接受、5,934 条预提交拒绝，实际持久化 66 条，待发送计数回到零。
  保留水位：缺少 checkpoint、未封口前缀、grace 与 PG 故障条件均保持数据保护。
- 文档、依赖 hardening、安装契约、时间预算、模板保留、Helm/分布式 preflight、观测配置、镜像闭包检查通过。
  高/严重依赖门禁通过；仍报告 Fastify/Nest 的 moderate 项，不是零漏洞声明。

没有重跑真实服务商/真实 Cube、完整产品浏览器、混合 API/大图/SSE 容量、2k/10k SSE、多机故障、
协调备份恢复或全新机器安装。既有部署验收可以说明对应历史版本的结果，不能替代这些范围的当前验证。
这些仍是 BACKLOG 中的独立验收工作。

## 架构评价与后续切片

当前“有序日志 + 可重建内存视图”用在正确的位置：热点追加和工具路由避免每次查 PG，
接收/换主/撤销/资源销毁仍由持久权威确认。继续扩大内存视图时，应先证明失效和重建，
不能将“缓存里没有”当成“数据库已撤销”或“VM 已消失”。

共享 Session writer 和共享 Kafka 分区是两种不同的等待范围；近期拒绝隔离与分区恢复测试保持了这一区别。
CP 合并部署的模块依赖目前没有证明必须拆进程。需要测量的是 CPU/内存/连接池干扰，
单次图片改成流和新增读池还不能给出整个进程的容量结论。

最大的维护责任仍在 Cube 执行扩展：它实现的是接管、停止、去重、探测、回包协议。
Helm 声明式发布已统一配置来源，但不会自动解决其运行时状态机的问题；D2-01 是具体例子。
应围绕这些协议做独立契约和升级验证，而不是通过多加一层转发来掩盖职责。

下一步宜分成输入预算、子任务时间、回收公平性、验证入口、子任务维护范围五个主要切片。
两个 P3 作为小修处理。Cube admission 的恢复范围在确认设计后单独做。

## 复现入口

```bash
# 必须指向新建的隔离 loopback PostgreSQL；脚本自行新建/删除随机测试数据库。
PI_CLOUD_REVIEW_DATABASE_URL=postgresql://postgres@127.0.0.1:<test-port>/postgres \
  node --import tsx scripts/review-20261003-r2-probes.mjs

# 从仓库当前补丁生成临时 Go 源码，仅运行 manager 特征测试。
node scripts/review-20261003-r2-cube.mjs
```

这些是描述基线问题的特征复现，通过意味着观察到了报告中的行为，不意味着问题已经修复。
Kafka 测试使用本轮新建的独立三 broker 集群和唯一 topic；没有改动生产网络/配额或数据。
