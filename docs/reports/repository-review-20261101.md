# 全仓特性与架构 Review：2026-11-01

审查基线：`main`，`c636fe7a`。线上应用为 `same-worker-recovery-20261031`，
应用源码 `79a01393`，schema 206。本次只审查和记录，没有修改运行时代码、
重启线上组件、操作原会话或销毁用户资源。

结论：PG、Kafka、Pi Worker、Projector、Cube 这套职责划分可以继续保留。
没有发现必须更换 Agent Harness、重新引入 Broker 或另建调度系统的依据。
当前更明显的问题是：部分外围路径没有完整遵循已经建立的协议；新增功能
又各自解释了一遍能力、状态和生命周期，产生了局部不一致。

本次记录 **8 项待修复发现**：2 项高优先级，4 项中优先级，2 项维护问题。
另列出已有的运行限制和需要测量的成本，避免把设计取舍一概称为 bug。
“没有新增发现”只表示在本次覆盖中未确认新缺陷，不代表经过形式化证明。

## 审查方法与边界

- 清点了基线的 2,312 个受版本控制文件、**23 个 package**，以及部署、脚本、
  CI、文档入口。重点链路逐段读实现、调用者和测试；不是对每一行都做同等深度审查。
- 回顾本轮提供的完整用户讨论，按特性检索本地两份长会话。建立了 14,829 条
  可见用户/助手消息的元数据索引，用于核对设计原因；没有把会话正文、工具输出、
  凭据或用户仓库写入版本库，也不声称逐字重读了全部历史记录。
- 先读当前 README、文档地图、架构、Roadmap、Backlog 和对应 ADR。旧报告、
  旧迁移和早期会话只解释来源，不能覆盖后来已接受的设计。
- Pi 对照对象是仓库固定的 `@earendil-works/pi-durable` / `pi-ai` / `chord`
  **1.0.0** 及其公开接口；Cube 对照固定源码和本仓维护的补丁契约。
  本次不是上游最新版本升级评估，也没有把历史 Codex 行为当成当前实现事实。
- 验证使用独立 PostgreSQL、RF=3 Kafka、临时浏览器、临时文件和自有测试进程。
  网络期限实验的所有实际连接都在 loopback。本次没有对线上做破坏性故障注入。
- 所有发现都区分源码证据、隔离复现和历史线上证据。未重跑真实付费模型验收，
  未重开用户明确暂缓的 131 MiB 冷图片请求实验。

脱敏结果见 [机器可读证据](repository-review-20261101-evidence.json)。
原始本地日志和隔离探针保留在忽略目录
`deploy/production/runtime/work-evidence/repository-review-20261101/`。

## 发现一览

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| R01 | P1 | Sandbox 控制器永久丢失所有权后，主服务仍可能 Ready，且不自动退出恢复 | 实际 PG 过期复现、主探针接线、此前线上事件 |
| R02 | P1 | 旧安装/部署入口可以绕过 matched release 的停写、清场和发布记录流程 | 可达脚本调用链与 Helm pre-upgrade hook |
| R03 | P2 | Fork/prune 的目标校验仍读取整段导航正文，超过 10,000 个导航节点直接拒绝 | 实际 PG Fork 及超限复现 |
| R04 | P2 | Skill 能力判断与 Worker 实际工具集不一致 | max 模式调用真实能力选择方法复现 |
| R05 | P2 | 阅读历史时冻结了 Run 终态，失败后仍可能显示正在工作 | 实际浏览器复现 |
| R06 | P2 | 沙箱 HTTPS 出口在连接满 5 分钟时无条件断开，持续传输也不例外 | 源码及本地隧道期限回调实验 |
| R07 | P3 | `prepare_skill` 被硬中断后遗留临时目录，成功重试也不清理 | 杀死自有子进程后重试复现 |
| R08 | P3 | 部分验收入口和“当前”文档已落后于现有版本，检查不能发现这种漂移 | 固定旧 schema 断言、过时状态、失效计量匹配 |

P1 表示优先修复的可用性/发布正确性问题；P2 表示特定正常场景下的功能或性能问题；
P3 表示清理和维护问题。这里没有把内网部署扩展成一轮攻击面审计。

### R01：失去 Sandbox 所有权，却仍然对外表示可用

**用户会看到什么。** 控制面进程短暂卡顿或 PG 连接中断，时间超过 Sandbox owner
的租期。恢复连接后，一些工作区操作、绑定清理或恢复持续失败，但 Pod 看起来仍是
Ready。等待也不一定恢复，需要控制器重新建立有效所有权。

**原因。**

1. [WorkspaceRuntimeStateRepository](../../packages/sandbox-control/src/workspace-runtime-state-repository.ts)
   的续租循环在 L424–432 吞掉失败。L2243–2265 正确地拒绝给已经过期的身份续租。
   这条拒绝规则应保留，否则会破坏 fencing。
2. [SandboxControlRuntime](../../packages/sandbox-control/src/sandbox-control-runtime.ts)
   L433–435 的 `ready` 只检查是否启动、是否正在关闭。
3. [主服务 readiness](../../packages/control-plane/src/main.ts) L532–535 只组合上述布尔值、
   Kafka ingest 和 `SELECT 1`。PG 已恢复可达，并不表示原 owner 仍有效。
4. 内部 Sandbox HTTP 服务自己的健康检查会访问所有权，但 Kubernetes 检查的是
   主服务端点。[主服务 liveness](../../packages/control-plane/src/production-http-gateway.ts)
   L118–120 又始终返回成功。

**证据。** 在独立 PG 中让实际 repository 的 owner 过期，健康检查返回
`ownership_lost`；继续运行续租周期后仍过期，数据库行的 `state` 仍为 `ready`。
主端点错误组合由源码确认，没有在生产环境人为制造过期。
此前 [timing-reader 发布记录](timing-and-reader-20261031.md) 已观察到同类现象：
已结束 Run 的关闭绑定不能清理，控制面重启后正常恢复，VM 无须删除。

**改善方向。** 将“已确认永久失去所有权”传播到聚合 readiness 和组件退出/重建流程；
短暂查询失败与永久 fenced 要分开处理。仅改成永远 NotReady 仍不能恢复，因为
Kubernetes 不会仅因 readiness 失败就重启容器。保留过期身份不得复活的规则，
也不能把这个错误当作 VM 已死亡或可释放配额的证据。

**修复验收。** owner 过期后主入口停止宣称完整可用；经过受控恢复能清理旧绑定；
迟到旧操作不能重新获得权力；原 Workspace/VM 不因诊断失败被误删。

### R02：发布纪律存在一个仍对用户开放的旁路

**场景。** 用户按安装脚本最后提示的 `Reconcile later: ./install.sh`，在更新源码后
重新运行安装；或者直接使用 `npm run production:deploy` / `production:up`。
这条路径可以更新已有集群，而没有进入维护中的 matched release 前置检查。

**源码证据。**

- [安装脚本](../../scripts/install-self-hosted.sh) L507–508 计算了
  `runtime_was_initialized`，后面却没有据此区分首次安装与已有集群升级；
  L531–538 继续执行 Cube reconcile 和 `production:deploy`。
- [run-production-deploy](../../scripts/run-production-deploy.mjs) 直接初始化、
  注册模板、构建、导入镜像并调用 `production-kubernetes deploy`。
- [production-kubernetes](../../scripts/production-kubernetes.mjs) L271 起的 deploy
  验证了 Cube/guest 构建身份，**这些检查是有价值的**，但未验证活动 writer、
  VM 清场、匹配发布证据和发布锁；L357–365 直接 `helm upgrade --install`。
- [bootstrap Job](../../deploy/helm/pi-cloud-platform/templates/bootstrap-job.yaml)
  是 `pre-install,pre-upgrade` hook，会在应用替换前执行数据库 bootstrap/migration。
- 相比之下，[matched runner](../../scripts/run-matched-release.mjs) L184 起检查
  Runs、writer、绑定、terminal、VM，并执行有序停写及匹配发布记录。

**影响。** 在需要破坏式匹配升级时，旧进程可能还在使用旧结构，迁移已经开始。
即使恰好只有兼容改动，这条路径也可能改变 serving image catalog，而没有同步
维护 scoped release 所依赖的完整 provenance。这里确认的是**保护缺口和可达路径**，
没有故意在有用户任务的线上执行它，也不声称已经造成数据损坏。

**改善方向。** 首次安装保留 bootstrap 路径；已有部署必须转入 maintained release，
或在任何修改前明确拒绝。底层部署动作只能由通过检查的发布流程调用。
删除/收拢过时公开入口，不能靠 README 提醒操作者“记得别用这个命令”。
也不要把公共“释放开发机”当作升级清场，它会删除 Workspace。

**修复验收。** 用命令替身验证：检测到已有部署/活动 writer 时，旧入口在任何
Helm、模板、目录或 migration 写入前停止；首次安装和正式 matched/scoped release
各自仍能完成，发布记录与实际制品一致。无需拿生产会话来做这个测试。

### R03：共享 Fork 已经省掉正文复制，但入口校验仍随导航历史增长

**场景。** 同样是一个很长的会话，如果大部分内容是 Tool 输出，现有大历史实验
可以很快 Fork；如果积累了很多用户消息、follow-up 和助手正文，Fork 前仍先读取
这些导航正文。超过 10,000 个相关导航节点时，目标即使有效也会被拒绝。
这里的节点数不是 Tool 数，也不是等同于 10,000 个 Run。

**原因。** [conversation-tree-service](../../packages/control-plane/src/conversation-tree-service.ts)
L192–235 的 `sessionEntries` 调用 `readDurableEntries(navigationOnly: true)`，
但 [history reader](../../packages/pi-session-postgres/src/durable/history.ts) L62–79
仍以 64 行分页读取 `l.body`。Fork 在 L1218–1245 先载入完整导航分支、已结束 Turn，
再查找指定目标；prune 使用同一类校验。超过 `MAX_TREE_ENTRIES=10000` 直接报
`Conversation tree is too large`。

**独立 PG 实测。**

| 输入形状 | 读到的导航正文 | 本次 Fork 调用 SQL | 耗时 | 结果 |
| --- | ---: | ---: | ---: | --- |
| 256 条、每条约 32 KiB 的助手导航正文 | 256 行，8,490,792 bytes | 63 | 471 ms | 成功 |
| 10,001 条较小导航记录 | 10,001 行，4,338,224 bytes | 163 | 371 ms | 超限拒绝 |

这些是本机隔离样本，不是生产 p95。它们说明还有线性读取成本，不否定共享根
导入的改进，也不推断所有 1 GiB 会话都会慢。

另有验证盲点：[conversation-tree 测试](../../packages/control-plane/test/conversation-tree.postgres.test.ts)
L414 仍匹配旧 SQL 文本 `c.committed_at`，实际查询使用 `l.committed_at`；
该统计本来只覆盖 `tree()`，L439 的 Fork 又使用未插桩的 service。
因此“tree 正文读取为零”的断言不能证明 Fork 的目标校验也不读正文。

**改善方向。** 利用现有目录中的 Entry、Conversation、Turn、提交位置和可见边界，
点查指定目标及所属路径，仅在确实需要上下文时读取对应后缀。不应只提高 10,000
上限。保留原生 ID 排序与提交序号的区别，不能把“ID 较小”误认为“Fork 时已提交”。
新的计量测试应首先证明计量器能命中实际查询，再分别测 tree、Fork、prune。

**修复验收。** 文本密集、Tool 密集、多次 compaction、嵌套 Fork、迟到小 ID
提交都覆盖；有效目标不因终身导航条目数失效；读取量与目标所需范围相关。

### R04：Skill 和真正执行的 Agent 在用两套能力答案

**例子。** max 模式下，用户明确要求使用一个会委派子 Agent 的 Skill。
实际 Worker 提供 `subagent`，当前策略也允许用户或明确采用的任务说明要求委派；
但 Skill 系统把它标记成“不支持：缺少 subagent”。

**原因。** [SkillMarketService](../../packages/control-plane/src/skill-market-service.ts)
L271–302 硬编码部分工具，非 ultra 时删除 `subagent` 和 `workflow`，并总是返回
`runtime: linux`。它查询的是 root Run 的 thinking 和 Conversation ID，没有按
当前 child 的 Workspace/写入能力等 grant 重新解析。

真正的 [WorkerToolRuntime](../../packages/supervisor-host/src/tools/worker-tool-runtime.ts)
按角色、Workspace、深度等条件选择工具；
[Agent profile](../../packages/protocol/src/agent-profile.ts) 和
[delegation policy](../../packages/sandbox-supervisor/src/durable/delegation-policy.ts)
把非 Ultra 定义为“需显式要求”，不是“工具不存在”。这是后续已经采用的策略，
不能拿早期只在 Ultra 开放的讨论覆盖它。

**证据。** 用真实 Worker 工具选择和 Skill 判断方法，配合 max/root 的确定性
查询结果，得到 `actualSubagentOffered=true`，Skill 却返回
`unsupported: tool:subagent`。这个实验验证能力判定，不是一次真实模型委派。
源码还显示无 Workspace/受限 child 可能得到过于宽泛的 Linux/文件工具描述；
该方向没有另做真实 child 验收。

**改善方向。** 从现有 catalog、grant、角色解析同一份有效能力；区分“提供这个工具”
和“什么时候允许模型主动使用它”。可提取纯函数/明确能力快照，不必再增加一个服务，
也不需要每次读 Skill 都 RPC 查询 Worker。执行端仍保留最终 admission。

**修复验收。** root/child、无 Workspace、只读/可写、max/Ultra、工具动态变化
在 Skill 和 Worker 上得到一致能力结论；显式委派策略不被绕过。

### R05：保护阅读位置时，也把“任务已经失败”冻住了

**例子。** Agent 正在输出，你稍微向上滚动读前文。随后本轮失败。
底层 live state 已经是 `failed`，阅读区却继续显示“正在工作”，失败原因没有出现。
页面有通用“新内容／返回最新”提示，点击返回最新后才看到失败。

**原因。** [ConversationTimeline](../../packages/web-ui/src/ConversationTimeline.tsx)
保存冻结的阅读页，只合并已知 Tool 的新状态。
[refreshKnownTools](../../packages/web-ui/src/history-window.ts) L112–161 保留旧 Turn
字段；L165–184 的 `observeHistoryPages` 只处理正文 identity 的结算重命名。
所以页面几何/文字不动的同时，Run 状态也停在旧值。

**浏览器复现。** 在现有长会话布局 fixture 中向上滚动 12px，发送 `turn.failed`：
`liveStatus=failed`、`renderedFailure=false`、`working=true`；返回最新后失败可见。
原有的工具展开、选中文本、位置保持检查同时通过。

**改善方向。** 将正文/滚动锚点冻结与执行状态展示分开。失败、取消、结束应保持
真实，可以在稳定状态区更新，不能强迫用户滚回底部，也不能为了更新状态破坏
原生文字选择。冻结的半截正文不能因此被当作完整答案复制。

**修复验收。** 阅读、选中、多页历史三种状态下收到 completed/failed/cancelled，
状态及时变化，选区和滚动位置不跳，回到最新后正文无重复。

### R06：有正常数据流量的 HTTPS 连接也会在五分钟时被切断

**场景。** 沙箱里一个较慢的大下载、长时间 HTTPS 流或 WebSocket 隧道，连接
始终有数据，却在五分钟左右断开。Bash 本身允许继续运行，网络传输先被本地代理结束。

[cube-egress-gateway](../../packages/cube-egress-gateway/src/proxy-server.ts)
L19 定义 `CONNECTION_DURATION_MS=5*60000`，L264–267 设置绝对计时器。
它不随数据到达刷新，也不区分空闲与持续传输；与建立连接的 10 秒期限是两回事。

**实验。** loopback 假上游建立隧道并成功回显 10 轮数据；始终只有最初的 300,000ms
计时器。触发这个已注册的期限回调后，仍活跃的连接被销毁。实验加速了期限，
没有真的等待五分钟，也没有连接公网目标。

这只指 **Sandbox 公网出口**。不能用它解释 Worker → CLIProxyAPI 的历史 TLS EOF，
后者是另一条链路。本次也没有证明以前某次 npm/pip 失败就是此原因。

**改善方向。** 明确区分建连期限、无流量期限和人为总寿命限制；保留有业务意义的
超时，把活跃连接的绝对上限改成明确可配置的策略，或移除这一未暴露的默认限制。
超时日志应能区分原因，不能把正常持续工作伪装成上游随机断连。

**修复验收。** 模拟时间下连续传输越过原五分钟边界仍可用；空闲和建连失败仍能
按配置结束；代理配置切换、新旧连接及取消清理行为保持清楚。

### R07：Skill 准备中断会积累不可见的半成品

[prepareSkillPackage](../../packages/tool-sandbox/src/skill-package-files.ts)
L86–106 在持久 Workspace 下创建 `.pi-cloud/skills/.prepare-*`，写完再 rename。
普通异常有 finally 清理，但进程被 SIGKILL 或 VM 突然断电时 finally 不会运行。
下一次成功调用只处理自己的临时目录，没有回收前一份。

隔离实验在创建临时目录后杀死自有 Node 子进程，产生 1 个遗留目录；重试成功后
它仍存在。没有误报正常安装目录为垃圾，也没有修改用户文件。

**改善方向。** 给受管理 staging 增加能识别“仍被使用”的生命周期标记和保守回收。
可以参考本仓上传 staging 的锁/清理方式，不需要额外 PG 任务表。不要按 `.prepare-*`
名称或年龄直接删除用户可能修改、或另一个调用正在使用的目录。

**修复验收。** 普通取消、硬中断、并发 prepare、成功重试都覆盖；最终包原子可见，
确认废弃的 staging 可回收，活跃/用户修改内容不会被误删。

### R08：维护中的验证证据没有全部跟着架构更新

三个具体例子：

1. [model-runtime driver](../../scripts/run-live-model-runtime-check.mjs) L98
   要求 schema `195_gpt61_sol_selection`；
   [control-plane-outage driver](../../scripts/run-live-control-plane-outage-check.mjs)
   L252 要求 `192_unbounded_agent_work`。当前是 206，原样执行会在真正验收前拒绝。
   后者仍由当前 [matched release 操作指南](../MATCHED_RELEASE.md) L519 给出执行命令。
   保留前置不匹配拒绝是正确的，但这些脚本不能继续被当成当前可运行验收入口。
2. R03 的 SQL 计量测试匹配旧别名，统计为零不再能说明实际读取为零。
3. `READING_PROGRESS.md` 开头仍把 schema 200 的旧发布称为当前 serving；Backlog
   后段还将已经有 [交付记录](control-plane-release-delivery-20261025.md) 的控制面
   独立发布写成未实现。它们会误导后续 review 和操作选择。

当前 [documentation check](../../scripts/check-documentation.mjs) 主要验证路径、
npm script 存在以及少量禁用旧表述，并不验证“当前状态”的新鲜度。
本次安装、Helm 和运行策略检查全部通过，也没有覆盖 R02 的已有集群入口保护。
所以“测试全绿”不能替代场景覆盖审查。

**改善方向。** 给每个执行型验收明确“当前维护”或“历史复现”身份。维护入口应读取
当前契约/发布元数据并校验所需能力，不能简单删掉版本检查，也不能永远写死旧迁移名。
历史报告保留原事实；当前文档去掉重复 serving 摘要，指向单一发布事实。
计量测试加能确认探针命中真实操作的正向断言。

## 按我们讨论过的特性逐项核对

| 特性 | 当前实现与设计意图 | 本次评价与限制 |
| --- | --- | --- |
| 普通用户输入、重试、即时反馈 | 先登记 PG；稳定幂等身份；本地 sending 反馈与真正接受分开 | 方向正确。接受失败保留草稿，不凭 UI 乐观状态启动任务 |
| Run / Session / child | 一个物理 Session 一个 writer/lease/Worker family slot；child 是原生 Conversation | 没有恢复 child Run/RunAttempt 双重调度；保留该简化 |
| PG → Worker | 短领取事务、SKIP LOCKED、通知加兜底扫描、Worker 本地容量 | 不能为了少一次 SQL 去掉授权事务或 Workspace 删除互斥 |
| Worker → Kafka | 稳定事务 producer，初始化前后 PG 授权；普通提交不再查询 PG | 没有恢复旧 HTTP 发布入口。Kafka 顺序不能代替外部副作用 admission |
| Projector | 单组处理历史、视图和 Tool routing；有序控制变更更新内存视图 | 当前热点读模型方向合理；不能把缓存当 Run/资源变更权威 |
| Tool dispatch / reply | 先持久确认派发边界；Cube 接管执行；boot reply 找原 callback；Worker 做原生结果结算 | 故意不承诺 shell exactly-once。丢失接单/回包仍可能 UNKNOWN，不擅自重放 |
| 部分 Tool call、工具预览 | 未完成参数留 Worker；完整意图才提交；工具进度走观察通道 | 没有因 UI 展示需求恢复 PG 临时日志。最终结果替换预览的浏览器检查通过 |
| Stop / UNKNOWN / 恢复 | Pi abort settlement，有序 operation cancel；旧结果不覆盖终态；不回溯杀已完成后台工作 | 同 Worker 新 lease 的身份修复相关测试通过；本次未重做线上进程故障实验 |
| follow-up / steer | Pi Inbox/Submission 当前值；编辑、删除、重排、立即 steer；持久化后确认 | 不是每条创建云端 Run。停止后未消费输入回草稿，已消费的不能冒充未发送 |
| 原生日志、流式与恢复 | 历史事实、current-state 和 live suffix 分开；PG 结算/交接检查点 | 符合此前减少 pi.live/Inbox 中间版本的要求；不是把所有状态都长期 append 一份 |
| Fork / prune | 共享不可变正文；单路径 Fork；旧 child runtime 不继承；手工 Fork 平级；Workspace 继承 | 保留现有语义，修 R03。不要为查询旧 child 再把整个家族复制给 Fork |
| 中断正文 | 通过公开上下文调整保留可读的中断文字，不重传半截 Tool 参数/推理结构 | 未改 Pi loop。额外上下文表示是已接受取舍，不应在此次审查中暗中撤销 |
| /usage、/compact | usage 使用模型 usage/原生估计；active compact 为原生任务，idle compact 复用维护 Run | 输入式交互及重复请求/丢回复浏览器检查通过；usage 不能被解释为精确远端排队诊断 |
| 模型等待、续传、模型目录 | 模型路由快照；CPA 持有 continuation；Worker 保留完整原生请求语义 | 普通大小跨 Worker 续传有先前实测；131 MiB 冷请求仍是已知未验收范围 |
| Ultra / subagent / workflow | Ultra 映射 max 思考和主动委派；其他档有工具但要求显式委派；同 Session 多 Conversation | 能力与策略应分开，R04 正是目前重复解释产生的不一致 |
| 动态 Tool catalog | 执行侧声明目录，现有管理连接更新 Worker，后续模型请求看到变化 | 不需要 Worker 加载不可信插件；更改执行协议仍需匹配发布 |
| Skills | 标准目录包、不可变版本、租户/个人/项目安装、Run 选择；脚本放 guest 再执行 | 分层合适；修能力判定 R04 和 staging 清理 R07；不是任意自定义 Worker Tool |
| 定时计划 | PG 计划、索引唤醒、原子触发普通新 Run；忙时按现有策略排队/合并 | 不另建 agent loop，也不冒充 steer；浏览器编辑/停用/删除检查通过 |
| 常驻/弹性 VM | PG 用户意图；Cube 实际分配；常驻自动恢复、暂停不自动拉起；Cubelet 有限弹性回收 | 生命周期边界正确。R01 是控制器所有权恢复缺口，不是需要把权力交回 Tool broker |
| Workspace / Volume / 删除 | Volume 是唯一文件权威；先关闭 attachment admission，再核对节点引用及物理清理 | 不凭心跳或零引用猜测删除安全；独立节点丢失/UNKNOWN 引用的运维验证仍有限 |
| Upload / 图片 / 生图 / 展示 | 原图对象存储，Kafka 传引用；主动图片作为视觉输入；生成/展示复用附件与普通 Tool 路径 | 结构合理。对象存储、模型输入与临时 Workspace 副本有不同生命周期，不能误删 |
| 浏览器、preview、终端、SSH | 浏览器在 guest；preview 返回用户可访问地址；终端/SSH 走独立受控连接 | 图片和 preview 展示专项通过；活跃终端跨替换不能自动承诺无感 |
| 长会话网页 | 有界分页/虚拟化、历史锚点、自动边缘加载、工具折叠、选择保护、单行重试 | 主交互通过；R05 说明正文冻结与执行状态不能使用完全相同的更新规则 |
| GitHub/GitLab 集成 | webhook/Issue 幂等记录、用户选择执行、普通 Run admission、受控临时凭据 | 保留行锁的并发作用；没有发现需要独立任务框架的依据；本次未连接真实代码托管商 |
| 手机执行原型 | 仍保留独立 executor/operator 原型，Web 不提供云手机选择 | 符合用户当前边界；不把它宣传为已支持任意设备，也不新增设备锁系统 |
| 部署、代理、模板 | scoped/matched release、固定依赖、统一上游代理、声明式 Cube 扩展 | 正式路径比早期可靠，但 R02 公开旁路及维护工具缺口仍须收拢 |

## 对架构的批判性评价

### 应继续保留的部分

**事实、执行权和物理资源分开，确实有作用。** PG 接受输入并分配执行权；Kafka
确认活跃 writer 的有序提交；Pi 决定继续哪些原生任务；Cube 管实际工具执行。
一个节点的诊断信号不能越权决定另一层的持久事实。这解释了系统为什么有一定复杂度，
不是所有表和消息都可以合并成“一份日志里什么都有”。

**Append-only 不是要求所有数据都只增不改。** 对话事实适合保留历史；待处理 Inbox
和 input metadata 适合当前值；运行中 UI 进度可以是可丢观察。现有分层比重复保存
每次编辑和每个流式全文更贴合我们的目标。不要退回单个万能 JSONL，也不要新建
一套和 Pi 竞争的任务数据库。

**单个 Session 共享 writer 是合理边界。** 主/子 Agent 在同一个 Harness/Worker 家族
中，原生 Task/Conversation 区分工作，物理 Session lease 区分执行者。
同 Worker recovery 的近期修复正是把逻辑 Run 与执行身份分开，没有必要恢复 RunAttempt
表或每个 child 的独立租约。

**Cube 回包有价值，但属于定制执行协议。** 它把长工具生命周期和回包从控制面 HTTP
等待中移开。代价是要维护接单位置、boot 身份、取消、完成回包和节点丢失规则。
不能再把它描述成一个随时可换的简单 Bash 转发器。新增沙箱需要实现能力端口及相同
故障契约，而不只是把 create/exec 两个函数换掉。

### 当前真正的耦合在哪里

**最值得收拢的是规则的多个解释者。** R04 的 Skill 与 Worker 能力、R01 的内部所有权
与主 readiness、R02 的正式与旧发布入口、R05 的 live 与冻结阅读页，都不是缺少更多
中间件，而是同一事实跨边界后被重新解释。应复用小而明确的能力解析、健康聚合和
发布前置契约，保留消费者自己的展示/执行职责。

**控制面组件很多，不等于需要拆微服务。** SandboxController 约 3,766 行、Web ChatApp
约 2,725 行、Cube provider 约 2,595 行，生命周期决策仍集中在少数大文件。
最近的 capability port 拆分是有益的，但继续增加 feature 时应按“一个状态机/一个
事务边界”拆内部模块，避免不同对象各存一份实际资源状态。现在拆成更多网络服务
会增加恢复和协调负担，没有测量依据。

**共享历史解决的是持久正文复制，不保证每个上层操作都常数时间。** R03 是典型例子。
同理，减少 SQL 次数不是唯一目标：一个会读几百 MiB 的 SQL，可能比多个索引点查更贵。
对于登记 Run、删除 Workspace、占有 lease，数据库事务是正确性边界，应保留；
对于已按 Kafka 顺序更新的 Tool binding/catalog 读路径，继续用已有内存视图。

### 已有运行限制，不作为这次新发现重复包装

1. **Worker 的 Boot 凭据默认 24 小时，没有自动续发。**
   [provisioner](../../packages/control-plane/src/supervisor-boot-provisioner.ts) L19、L438–472
   验证到期；[Worker runtime](../../packages/supervisor-host/src/runtime.ts) 只在启动时登记，
   重连复用原凭据。到期后遇到控制面替换/网络重连，会走拒绝和 Worker 恢复，不能承诺
   长期 Worker 永远无感重连。**不是每个 Run 到 24 小时就强制结束**，已有连接可以继续。
   这是 Backlog 已记录的限制，下一步应测跨到期重连并设计同一 Boot 的续发，保留撤销语义。
2. **完整匹配升级仍要求清空物理计算实例，通用 compute-only 退休命令尚未交付。**
   既有发布通过受控维护步骤保留 Volume 和 desired-running，再恢复 allocation；
   不能把这种人工步骤称作从干净仓库即可一键完成。应先维护这条操作路径，再研究
   哪些兼容 Worker 变更可以进一步缩小发布范围；不自动恢复任意应用进程。
3. **共享历史回收、图片准备和大量活跃 children 的成本仍需独立容量测量。**
   已有目录/回收是有界的，但生产清理速度、每次冷准备重复 hydration、并行原生
   context 内存还没有足够的持续负载数据。model permit 限制模型请求不等于限制全部
   preparation 内存。先增加已有指标的分解样本，不急着加 Redis、全局缓存或新 scheduler。
4. **单主机恢复证据不等于多机 HA。** PG 故障转移、独立 Cube 节点死亡、UNKNOWN
   Volume 引用核对、长期 2,000/10,000 SSE 连接、持续多租户负载仍有待验证。
   保持未知状态保守处理，不用删除保护记录来换“看起来恢复了”。
5. **上游模型延迟仍不能完全由本地推断。** 当前阶段耗时日志能区分准备、hydration、
   本地 Gateway 和 HTTP 等待，但无法仅凭一次首字延迟判定是远端排队、VPN 还是服务商。
   CPA continuation 已减少可复用请求的上游重传；失效/冷请求仍需要完整上下文。
   不因此强制降低图片质量，也不偷偷恢复用户暂缓的大图实验。

### 本次没有采纳的误判

- 原生 token 估计没有把 opaque 图片引用当成零；固定 Pi 对非文本视觉块有结构估计。
  它仍是估计，不等于服务商精确计费。
- 上传 staging 使用持有 FD 的 OS 锁，不是只靠遗留 PID 文件判断活跃。
- Preview 流量已经参与弹性保活，不能因为 Worker 在纯聊天就认定应用预览会被立即回收。
- Workspace 业务记录存在与 guest 工作目录存在是不同问题，前者的 PG admission 检查
  不能用 Projector 缓存随意代替。
- 活动接单的有界 buffer、请求期限和运行总时长是不同层次，不能为“去掉产品上限”
  删除所有背压；R06 针对的是隐藏的活跃连接总期限。
- CI 没有单独的 `web` 分支不等于漏测 Web：当前改动分类会把普通 Web 源码送入 full。
- 历史数据库迁移、ADR 中出现已退休名称，不等于生产仍在运行那些组件。

## 仓库覆盖索引

下表列出每个 package 的人工审查入口与重点。所有有测试的 workspace 均参与本次
整仓检查；“重点”不意味着其他文件逐行证毕。部署补丁通过固定源码契约验证，
未把生成产物重复计为新的业务架构。

| Package / 区域 | 重点审查入口和场景 | 结论索引 |
| --- | --- | --- |
| `android-executor` | executor admission、位置/凭据、回包、隐藏原型边界 | 保留原型，不新增产品范围 |
| `control-plane` | store、queued inputs、compact、tree、catalog、Skills、schedule、source control、readiness | R01–R04、R08 |
| `cube-api-authorizer` | 固定 Cube 操作授权、Volume/分配边界 | 保留独立外部副作用 admission |
| `cube-completion` | 完成帧、流式读/截断、reply producer 生命周期 | 传输/取消测试通过；UNKNOWN 保留 |
| `cube-egress-gateway` | 配置热更新、HTTP/CONNECT、断开清理 | R06 |
| `database` | 当前 schema、lease/queue/当前值/共享根索引、事务和迁移使用 | 隔离 PG 全迁移/合同；R02 |
| `domain` | 状态转换、资源限制语义 | 未恢复第二调度权威 |
| `event-log` | Kafka transaction、producer fencing、group guard、错误分类 | RF=3 integration 通过 |
| `fake-model-server` | 原生响应、工具、流式/失败 fixture 与真实能力界限 | 用于确定性验证，不能代替付费模型 |
| `observability` | 脱敏、阶段耗时、metrics 与 readiness 聚合 | 日志保持观察用途；R01 |
| `pi-session-postgres` | Storage commit、current-state、live checkpoints、目录、Fork、retention | R03；保留 native/public Storage 契约 |
| `protocol` | 内部/公共消息边界、执行身份、capability、附件、Skill/计划 schema | 不恢复 per-record 签名或第二消息系统 |
| `provider-egress-relay` | 流式转发、断开/错误、等待边界 | 不与 Sandbox 出口超时混为一谈 |
| `runtime-core` | PG claim/renew、ordered closure、Projector dispatch、live/SSE、恢复 | source/fault/transport 覆盖；保留一 Session writer |
| `sandbox-control` | lifecycle、intent、binding memory view、Volume 清理、上传/preview/terminal | R01；物理不确定性仍不能释放所有权 |
| `sandbox-supervisor` | public Harness、Tool/Models ports、Inbox、compact、abort、恢复、管理重连 | 同 Worker 身份回归通过；Boot 到期限制 |
| `session-attachments` | S3/文件对象、claim-check、GC、规范化和失败消费 | 不新增原始回包缓存或第二文件权威 |
| `ssh-gateway` | ticket/连接归属、终端转发、关闭和过期 | 单次终端连接不能冒充可持久恢复任务 |
| `subagent-control` | native child start/wait/list、资源 grant、幂等、共享 Run lease | 继续保留原生 Conversation 管理 |
| `supervisor-host` | 启动授权、writer、模型 gateway、tool catalog、execution cleanup | R04；近期 Command identity 修复测试通过 |
| `tool-sandbox` | guest 固定工具、cwd、原生结果预算、取消、图片/Skill 文件 | R07；不让 guest 运行 Pi Harness |
| `web-ui` | composer、输入队列、SSE、长历史、选择/折叠、消息操作、资源/Skill/计划 UI | R05；主要浏览器交互通过 |
| `workspace-runtime` | staging、OS 锁、文件传输、权限与运行位置 | 与 Skill staging 的差异见 R07 |
| `deploy/` | Helm、Cube/CPA 固定补丁、镜像/启动契约、网络/观察配置 | R02、运行限制 |
| `scripts/`、CI | 安装、matched/scoped release、清理、验收、影响分类、检查有效性 | R02、R03 计量、R08 |
| README、docs、ADRs | 当前事实、历史证据、owner 决策与未做事项区分 | R08；本报告/Backlog 不冒充已修复 |

## 验证记录

本次 `npm run check` 完成所有 workspace typecheck、隔离 PostgreSQL 测试及
acceptance helper：**2,445 passed，11 skipped**。跳过项保留原 opt-in 条件，
没有改成无条件成功。RF=3 Kafka 专项另外 **8 files / 9 tests passed**。
这些套件之间存在覆盖重叠，不相加宣传为独立场景总数。

额外完成：

- Cube admission 补丁契约（包含 race、取消、位置、容量和探针边界）通过。
- Cube allocation 补丁针对固定源码、独立 MySQL/容器的检查通过。
- 浏览器完整 presentation、定时计划、Skill market 和历史阅读 probe。
- 安装契约、Helm、自托管/分布式预检、运行时间策略、observability、镜像闭包和
  Docker context 检查通过；这些是源/渲染检查，没有发布新镜像。
- R01、R03、R04、R05、R06、R07 的隔离探针；R02 用可达源码路径证明，未执行危险升级。

初始 Skill 浏览器 fixture 在并行运行时等待元素超时；保留初始失败记录，随后单独
运行同一 fixture（只加错误诊断）通过全部安装、启停、卸载、发布断言。
没有确认该超时的根因，所以不把它算产品 bug，也不抹掉初始失败。
Fork 探针初版使用了不存在的 sandbox-domain fixture，先因 FK 失败；修正 fixture
后重新执行成功，原失败不计入产品缺陷。

确定性 fault evaluation **379/379 项通过**，最终数量和状态记录在旁边证据 JSON；
它与整仓测试重叠，不是本次对生产集群执行的 chaos test。
文档链接检查及整仓格式检查也通过。之前的同 Worker、模型、原生恢复和资产保护
线上验收见 [原交付记录](same-worker-recovery-20261031.md)，不算作今天重新验收。

## 建议的实施顺序

1. **先修 R01、R02**：避免服务失权后假健康，以及更新入口破坏已有运行协议。
   同时让发布前置测试能覆盖所有公开入口；不要顺手扩大成新调度/发布平台。
2. **再做 R03**：保留共享历史结构，替换线性目标校验，并修好真正能计量的回归。
3. **修 R04、R05**：统一能力解释，分离阅读位置与运行状态。各自是独立垂直切片。
4. **修 R06、R07**：明确网络等待策略，补齐 staging 的硬中断清理。
5. **整理 R08**，并把 Boot 到期重连、compute-only 升级、共享根回收和多子 Agent
   内存测量列入下一轮操作性验收。

这轮 review 没有替用户改变上述取舍，也没有把待修复项提前标成完成。
下一轮最有价值的是按这些具体场景修复并实际验收，而不是再重复一遍无边界全仓扫描。
