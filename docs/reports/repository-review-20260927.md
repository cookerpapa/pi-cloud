# 全仓 Pi 对照、组件边界与精简审查

日期：2026-09-26 至 27 日。审查基线：`9a3b60f424661800ef5c84bf56f88bb025453158`。
状态：全仓审查、局部整改、验证和本地匹配部署均已完成。
实现提交：`b372f858a535d555f9806e69c392d81c2ee5faa5`；以下发现对应审查时的实现。

后续处理：用户已批准 D1 的正确性修复及 D3/D4 的等价重构，见
[后续实现与验证](repository-review-followup-20260927.md)。D5 随后获批并完成
[索引日志切换与验收](indexed-native-log-acceptance-20260927.md)；D2 也已按批准方案完成
[工具意图/命令合并与验收](tool-invocation-acceptance-20260928.md)。

## 范围与判定依据

基线含 1,105 个跟踪文件、21 个包、452 个 `src` 文件，其中 153 个为迁移及迁移索引。
检查了全仓引用、依赖、入口、协议和测试配置，逐项追踪主要执行、恢复与失败路径。
这不是第三方依赖逐行审计，也不把通过测试当成不存在其他缺陷的证明。

Pi 对照基准为实际安装的 **0.84.1**，包括 Agent Loop、异步监听、原生 Tool、
SessionStorage、Compaction 和 token 估算。另核对本地 0.86.1 源码
`c7cdb460aa8a0cebef3446c4166729b8a0d97ead`，没有升级 SDK 或把新版私有实现移植进来。

重新整理了 7 月 17 日开始的长期开发会话，并核对 9 月 19 日的单 Run/Session writer、
9 月 21 日的原生监听接口、9 月 22 日的完整工具与 Kafka 派发、9 月 24–25 日的进度和
审批讨论。以当前 ADR 校准历史提案，没有提交会话原文。

## 已修复的问题

### R27-01 · P1 · 工具回复的外层 Promise 可以使整个 Worker 退出

[远程 Tool 适配器](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts)先登记回复，
再等待命令发布。底层 mailbox 已处理自己的拒绝，但生产图片解码适配器又包装了一层
async Promise。发布失败或取消先到时，外层 Promise 尚无拒绝处理器，即使 Tool 调用者
捕获了错误，Node 的严格模式仍会退出，影响同 Worker 的其他 Session。

隔离子进程复现：整改前输出“调用者已捕获发布失败”后仍退出 1；整改后正常退出，
待回调数为零。现在立即观察回复 Promise，并由统一 finally 关闭等待。
保留先登记、后发布的顺序和 UNKNOWN，不重新派发工具。

### R27-02 · P2 · 完整工具切换后还保留了另一套旧执行接口

生产 Agent 已经只发完整 `tool.execute` / `workflow.exec`，但协议、Guest、Provider 和
部分安全测试仍保留 `bash.exec`、`file.read/read_range/write/mkdir/access`。
Provider 的 readFile/writeFile 端口也没有生产调用者；旧 Bash 捕获和原子文件写入代码
只由这套旧接口及其自身测试使用。

已删除这些协议分支、实现、端口、导出及旧替身。相关授权、租约、并发、VM 保留和
UNKNOWN 测试迁至实际完整工具路径。模板检查也改用原生 Tool，并按 ADR-0186 验证
Guest 内的相对路径，而不再测试已经取消的 Workspace-only 围栏。
人用的 Workspace/开发机浏览接口仍有独立授权和路径约束。

[Kafka 回复](../../packages/event-log/src/tool-replies.ts)同时删除了进度事件和回调分支，
只接受一次最终结果。Guest 的原生进度继续经 Broker HTTP/SSE；没有移回 Kafka 或模型
上下文。见 [ADR-0195](../adr/0195-final-tool-reply-lifetime.md)。

### R27-03 · P2 · 云端文本 read 改变了原生 Pi 的内容和行语义

Guest 使用 Node readline 拆行，会丢失 CR、末尾空行，且与 Pi 的 BOM 处理不同。
例如 `first\nsecond\n` 的第三行在 Pi 中是合法空行，云端却报越界。
六组实际 Pi 对照中原先五组失败。

[文本读取](../../packages/tool-sandbox/src/tool-worker.ts)现在按 Pi 的 UTF-8 解码与 LF
拆行语义流式处理，保留 CR、正确处理开头 BOM 与末尾空行。既有字节/行数边界保留。
六组对照通过；没有复制一套 Agent Loop 或将整个大文件搬回 Worker。

### R27-04 · P2 · 图片清理的更新范围没有使用完整租户主键

图片库存主键是 `(tenant_id, id)`。[Reaper](../../packages/session-attachments/src/store.ts)
先按完整主键选中并锁定对象，更新时却只按 id 匹配。合法地构造两个租户同 id 的库存行后，
旧逻辑会同时认领另一租户尚未达到清理期限的对象：真实 PG 对照得到删除数 2，而应为 1。

更新条件已改为完整租户/对象元组。回归确认只清理锁定对象，另一租户的图片仍可读取。
这是复合身份边界的确定性缺陷；没有声称生产发生过 UUID 碰撞或存在用户可调用的指定 id 上传接口。

### R27-05 · P3 · 历史压缩展示漏算图片引用

Worker 使用还原后的原生图片计算 token；冷读展示却把 `pi_cloud_image_v1` 直接交给 Pi
估算函数，图片被忽略。对照样例中原生结果为 **1,203**，历史界面只有 **3**。

[历史投影](../../packages/runtime-core/src/canonical-pi-conversation.ts)现在仅在本地估算中
把引用视为原生图片，再调用 Pi 的估算函数。没有下载图片，也没有把占位内容写入历史或
交给模型。模型实际识图和压缩阈值原本不受这个展示问题影响。

### R27-06 · P2 · 同一快照的读取被拆成多次 SQL 往返

| 路径 | 原来 | 现在 | 保留的语义 |
| --- | ---: | ---: | --- |
| 每次待发列表轮询 | BEGIN + 3 次读取 + COMMIT | 1 条 SELECT | revision、当前 Run 和队列来自同一快照，租户检查和顺序不变 |
| 冷 Writer 元数据与 Lane 头 | 3 次读取 | 1 条 SELECT | 仍按当前 owner 查询，元数据校验和 Lane 排序不变 |

对应 [队列读取](../../packages/control-plane/src/queued-input-service.ts)和
[Session Host](../../packages/pi-session-postgres/src/postgres-native-session-host.ts)。
回归覆盖查询数、编辑/领取竞争、父子 Lane、暂停投影和换 Host 恢复。
这些是 SQL 往返数量，不是 fsync 数量，也没有据此宣称固定的端到端加速比例。

### R27-07 · P3 · 控制面为共同管理类型直接依赖 Runner

Worker 身份、assignment inventory 和 Pi 固定版本曾放在 `sandbox-supervisor`。
现在统一归 [协议包](../../packages/protocol/src/worker-runtime-identity.ts)，全部生产引用
更新，旧文件、旧出口删除。控制面对 Runner 的直接依赖改为仅供测试使用。
消息字段和权限判断不变。仍存在经 trusted-tool-runtime 的传递依赖，见讨论项 D4；
没有声称 API 镜像已经完全不包含 Runner 源码。

### R27-08 · P3 · 失去调用者的代码和过时维护信息

- 删除未调用的冷 Lane 创建快捷函数、常量和六个解析包装函数，保留实际 schema 与
  当前公共 SessionStorage 方法；没有加别名或兼容转发层。
- 删除已由 9 月 21 日修复报告收束的 `claude-analysis/` 三份旧材料，共 647 行；
  必要历史通过 Git 定位，更新旧报告链接。
- 修正分布式部署“无需 S3 凭据”及旧 Flash 可见性说明，避免与当前附件/模型配置冲突。
- 普通付费验收默认改用 GPT-6 Luna；明确的 DeepSeek/跨供应商场景使用 Flash。
  搜索探针继续要求真实搜索事件，当前 Responses 不支持时不会伪装通过。
- 补齐 Control Plane 对 Session backend 的直接依赖声明；Kafka 和 p-queue 使用锁中
  已有版本的精确 pin，没有升级依赖。

## 需要汇总讨论的架构选择

建议先讨论 D1：它已表现为可复现的大小边界不一致，会影响结果持久化。
D2–D4 是保持当前故障合同前提下的往返和依赖精简；D5 需要先测量再判断。

### D1 · 非图片大结果的预算在不同边界不一致

真实 [WorkflowChannels](../../packages/tool-broker/src/workflow-channels.ts)接受了一份
合成的 1 MiB 返回值；最终回复约 **1,048,789 字节**，小于 5 MiB 回复上限。
实际 subagent Tool 包装后的结果约 **1,048,664 字节**，已经超过原生日志的
**921,600 字节**上限，尚未计入 Entry/Fact 外壳。

这会在工具完成后卡在 canonical append。图片引用解决了图片，并没有解决普通文本和
结构化 workflow 返回。没有在生产制造该故障；上述结果来自真实通道/包装器的合成输入。

建议先决定显式返回的预算和错误语义：优先要求 workflow 返回摘要和 Workspace 文件路径，
在源头拒绝过大返回并说明效果已发生。若希望保留任意大返回，再讨论是否扩展附件协议。
本轮没有扩大 Kafka 消息、自动截断结构化结果或引入新的文本存储权威。

### D2 · Tool intent 与执行命令仍分别确认

[CloudAgentRuntime](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts)先确认
`tool_started`，随后远程适配器另发 `tool_command` 并等待确认。这是同一工具调用的两次
串行 Kafka 发布；目前第一步确保效果之前已有可恢复的意图。

可以讨论是否把意图与执行描述合成一个原子日志单元，同时保持完整 Assistant 与 Tool
intent 的语义边界、Projector commit-before-effect，以及 after-hook 后的最终 canonical
结果。但需重设 Tool 准备接口、日志格式和恢复测试，不能仅删除其中一个 await。
本轮保留原合同。

后续已按 [ADR-0198](../adr/0198-atomic-tool-invocation.md) 完成四个固定远程 Tool 的
原子意图/派发切换，见[实现与验收](tool-invocation-acceptance-20260928.md)。

### D3 · 同 Worker 有两份租约观察

Worker execution backend 已批量续租，Native Session authority 又按活跃物理 Session
每秒查询 PG。后者负责独立发现丢失/撤销并中止原生写入，当前有安全作用。

可以讨论让两者共享一个本地、可中止的租约观察端口，减少重复查询；PG 仍为授权权威。
需要覆盖慢查询、迟到续租、冷恢复和父子 Lane，不能直接删除 watchdog。
Broker 是另一进程，其效果授权与 fencing 应继续独立存在。

### D4 · 剩余包边界与构建输入范围偏宽

trusted-tool-runtime 同时放置 PG 委派协调代码和 Worker 的 Pi Tool 装配，因此控制面通过
该包仍可传递依赖 Runner。CloudAgentRuntime 的批量 checkpoint 类型也由 PG backend 包
提供。下一步可以按“共同端口 / PG 实现 / Worker 装配”整理源码依赖，保留现有服务划分。

Guest Dockerfile COPY 整个 protocol/src，构建身份因此包含模型目录、网页协议等实际
Guest 不使用的源码。改模型目录也会重建四种 Cube 模板。ADR-0189 的保守完整性规则是
有意设计；可以讨论缩窄 Guest 输入模块或依据构建依赖闭包计算输入，不能跳过 digest/READY
校验或重新使用不匹配模板。

### D5 · 原生日志与查询投影的 payload 复制

PG 同时保存完整 native log 与 Entry/Record 查询投影。前者便于精确重建，后者服务
按 Entry、Lane 和 Turn 的读取。它们不是两个写入权威，但大文本仍有存储和 WAL 成本。
是否收缩投影为索引加日志定位，应先测量真实数据、查询计划和回放成本。本轮没有改变存储布局。
后续[独立 PG 存储布局研究](native-log-layout-study-20260927.md)已完成，证明日志直接
查询的可行性并记录约束；随后完成 [ADR-0197 实现与匹配验收](indexed-native-log-acceptance-20260927.md)。

## 核对后保留的边界

- Pi 拥有 Agent Loop、参数校验和原生 hooks；云端拥有租约、队列、持久确认和恢复。
  当前 SDK 高层应用的 TUI/本地文件管理不能直接搬进可信 Runner。项目 AGENTS 文本发现
  和持久审批仍按既有 backlog 管理，不作为这轮偷偷新增的功能。
- PG Run/control、Kafka R=3、统一 Projector、Cube Volume 和不可变图片附件各有明确职责。
  不把它们合并成共享文件，也不恢复旧 Fact Gateway、RunAttempt 或逐 Step PG 回执。
- 领取后的新快照读取、封口之后才放行下一 Run、Broker 的独立效果授权都保留。
  已恢复的中断前缀会在投影事务中清掉待恢复标记，因此没有误判为每次加载终生前缀。
- Subagent 的 start 和 wait 表示接受任务与等待完成两个阶段；普通模型请求、工具等待、
  子任务等待的资源预算不同，不能作为同一种锁或槽位删除。
- 历史迁移保留空库重建链；有日期/版本的验收记录保留为证据，不作为当前拓扑说明。

## 包与外围覆盖

| 范围 | 核对重点 |
| --- | --- |
| sandbox-supervisor | 原生循环、hooks、回复寿命、采样/重试/压缩、远程工具、输入和取消 |
| pi-session-postgres | 热 writer、冷启动、原生记录/投影、Lane、Fork、恢复标记、图片解码 |
| runtime-core | Run 领取/封口/取消、统一消费、回放、SSE、canonical 历史 |
| event-log | Kafka 确认、背压、dispatch commit、最终回复 mailbox 与 Worker 生命周期 |
| supervisor-host | Worker 装配、直接续租、Model Gateway、容量与本地模型许可 |
| trusted-tool-runtime | 委派 start/wait/control、workflow 桥、可信工具和预览 |
| tool-broker | 授权、固定工具派发、旧端口、Cube 机械操作、VM 保留、浏览/终端/预览 |
| tool-sandbox | 原生 Tool 算法、文件/进程行为、源端界限、图像处理和旧 Guest 分支 |
| control-plane | API 身份、受理、队列/steer、会话树、Worker 管理、开发机、代码托管 |
| protocol / domain / database | 活协议、状态机、引用/导出、版本 pin、schema 与迁移终态 |
| session-attachments | upload/ready/delete、租户复合身份、引用保留、失败与清理 |
| web-ui | 请求与取消、队列生命周期、SSE/快照、历史展示、模型选择和浏览器回归 |
| workspace-runtime | 有界初始化、路径和不覆盖既有 Workspace 字节 |
| cube-api-authorizer | 管理操作范围、凭据与异常输入边界 |
| cube-egress-gateway / provider-egress-relay | 公私地址策略、域名/端口、代理连接和关停 |
| ssh-gateway | 一次性 ticket、owner、WebSocket 终端和输出背压 |
| observability / fake-model-server | 安全日志/计时与测试注入；没有生产假模型 fallback |
| scripts / deploy / CI / docs | 旧调用形式、付费模型默认值、镜像/Cube 输入、Compose/Helm、检查入口和维护文档 |

## 验证与部署

[完整验证记录](repository-review-verification-20260927.json)和
[覆盖清单](repository-review-coverage-20260927.json)保存了本轮口径与源码摘要。

- 全工作区类型检查通过。全仓工作区测试得到 1,142 通过、121 个 opt-in 跳过、
  3 个失败；其中两个断言仍期待旧的 Flash/Pro 菜单，另一个仍期待已删除的 workflow
  progress 参数。只更新这些测试断言后，三个相关文件 **40/40** 通过；acceptance helpers
  **35/35** 另行通过。不重复计算重叠用例，最终结果为 **1,180 通过、121 跳过**。
  原 `npm run check` 因旧断言退出 1，没有将它描述为一次完整绿色执行。
- [故障矩阵](repository-review-faults-20260927.json) **65/65** 通过，PG 竞争用例使用
  独立真实 PostgreSQL。矩阵在提交前工作区运行，记录基线 `9a3b60f4` 和 dirty 标记；
  验证附件保存最终源码 SHA256。这不是生产故障或多机 HA 实验。
- 队列真实 PG、Native Host 和 SessionStorage 定向验证 **24/24**；图片回收与历史估算
  **11/11**；Broker 当前协议路径 **69/69**。它们与全仓/故障矩阵有重叠，不累加为总量。
- 浏览器队列与整页展示、Helm、观测配置、安装器、格式/文档、运行策略、镜像闭包与
  build context、锁文件 dry-run、依赖硬化检查通过。
- 依赖安全检查的 high/critical 门槛通过。仍有两项 moderate 的开发测试依赖发现
  （Vitest 与 @vitest/mocker），与 9 月 15 日审查记录一致；没有宣称依赖零漏洞。

[匹配部署记录](repository-review-rollout-20260927.json)：Control Plane、两个 Worker、
Broker 和 Web 均已运行实现提交的镜像，健康检查通过，关键源码摘要相符。
Guest 构建身份为 `00596951d4a524388bc38d0c78554b2dc9a318e5`，四种 Cube 模板匹配且 READY。
切换前确认无未完成 Run、活动租约和未封口 Session；未重启 PG/Kafka 等数据服务，
数据库仍为 `152_editable_pending_inputs`，没有新增迁移或保留混合版本兼容路径。

[真实 GPT-6 Luna / Cube / Chrome 验收](repository-review-live-20260927.json)全部通过：

- 原生 write/read/edit/bash，1.5 MB 命令输出的有界结果，以及 Guest `/tmp`、相对路径
  和符号链接行为通过。
- 长命令产生 50 条临时进度，静默命令不制造进度；取消后没有迟到进度，后续编码正常。
  此轮没有重复生产进程崩溃实验。
- 待发消息编辑、重排、取消和立即 steer 通过；顺序正确，被取消消息未领取，steer
  不产生重复的独立执行。
- Luna 只调用 bash 生成随机数字图片、read 读取图片，正确返回四位数字。
  不可变 PNG 对象为 **3,208,002 字节**，该会话的最大原生日志 payload 为 **2,610 字节**，
  图片记录保留引用。这是实际对象与 PG 原生日志的测量，不冒充 Kafka 网络抓包。

最后核对四个验收 Workspace 均已标记删除并完成存储清理，四个 Session 已归档。
全局未完成 Run、未释放租约、未封口 Session 均为零；独立临时 PG 容器已删除。
归档历史仍按合同保留它引用的图片，未作为孤儿强删。Cube 的旧模板保留策略删除了
四个旧模板，另有 11 个历史节点清理超时而延期，沿用既有运维 backlog。

以上是本机 Compose 两 Worker 与 Cube KVM 的验收，不是独立多机 HA 证明。
