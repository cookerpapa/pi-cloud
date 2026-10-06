# Pi Durable 迁移后的全仓审查

审查基线：`aace21a8f9082c43479a06ff428bac2b2e28d812`，2026-10-06。
对照版本：`pre-pi-durable-1.0`（`af73d1a5`，Pi 0.84.1）与仓库实际安装的
Pi Durable / AI / Chord 1.0.0。Cube 对照 `runtime-build.json` 固定的上游提交及全部补丁，
在独立临时目录应用补丁后检查有效源码。

本轮完成全仓审查，只新增复现脚本、验证记录和文档索引；未修复或部署产品代码。
当前设计依据为 ADR-0229/0230 及其仍有效的前置 ADR。历史报告和迁移文件用于解释决策，
不视为当前运行拓扑。审查覆盖各模块的职责、入口、关键实现、测试和相互调用，
不表示逐行重新验证所有历史报告、生成的 protobuf 和早期数据库迁移。

结论：原生 Harness 与云端执行授权的主干分工成立，迁移后仍存在恢复、事件关联和读取边界缺口。
这些问题不要求替换 PG、Kafka、Projector 或 Cube，也不支持“已经完全对齐且无需继续验证”的结论。

## 已确认问题

### R06-01 · P1：Compaction 的中途恢复依赖已经丢失的内存上下文

位置：`packages/sandbox-supervisor/src/durable/agent-session.ts:153`、
`packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts:497`。
原生对照：Pi 1.0.0 `harness/compaction` 的 `select`、`summarize` 和 `retry` 阶段。

PiCloud 在 `beforeCompact` 中，把请求所属 Task 和用途记入进程内的 `#requests`。
原生 Pi 在这个 hook 之后持久化 `summarize` 检查点。假如此时 Worker 丢失，新 Worker
会直接恢复 `summarize`；原生实现不会重新运行 `select` 中的 `beforeCompact`。
PiCloud 恢复了 Run/Conversation 的对应关系，却没有恢复请求上下文。
实际模型入口要求 `native` 存在，于是压缩请求被拒绝。

例子：上下文已经长到需要压缩，选择好保留范围后 Worker 重启。原生 Pi 能继续生成摘要，
我们的适配层却因为“不知道这个请求属于哪个原生任务”让摘要任务失败。
阈值压缩失败后原生流程可能继续普通生成；不能由此断言所有恢复 Run 都必然失败，
但本应可恢复的摘要请求确定失败，超长上下文时会进一步影响后续请求。

复现：`runtime-probes.mjs` 使用真实 Harness、记录过的原生提交和新的运行时实例，
恢复后请求用途依次是 `[null, "agent"]`，Compaction 终态是 `failed`。
模型端口采用与生产相同的“缺少 native task context 则拒绝”约束，无付费模型调用。

改善方向：从持久化的原生 Task/检查点重建请求身份，或使用覆盖每次恢复请求的公共接口。
PG 新授权仍然必须先完成。不要通过删除身份检查、允许无身份请求或再造一个压缩调度器规避问题。
验收覆盖 `summarize`、压缩重试、重复 Worker 恢复、Stop，以及用途/Fast 配置保持。

### R06-02 · P2：没有 partial 的响应会漏记或串用 sampling 身份，并影响正在运行工具的快照

位置：`packages/sandbox-supervisor/src/durable/run-events.ts:96`、`:168`；
`packages/runtime-core/src/canonical-pi-conversation.ts:326`。

`samplingStarted()` 将身份放入队列，只有 `message_start` 才取出它。
直接收到 `message_end` 时创建显示消息，却不推进这个队列。
第一条请求可能没有完成事件，下一条流式请求又拿到前一条请求的身份。

这是正常可达路径：ADR-0230 有意过滤纯 Tool call 的 partial；原生 Pi 也可能在
100ms partial 持久化窗口之前收到完整响应。因此不能假设每条响应都有 `message_start`。

复现中两次 sampling 的 sequence 为 11 和 22。第一次完成后完成事件为 `[]`，
第二次完成后为 `[11]`，而不是 `[11,22]`。

同一缺口还有可见后果：纯 Tool 响应结束时既没有文本事件，也可能没有 sampling 完成事件，
显示覆盖位置便没有推进到 assistant proposal。工具的原生 execute 检查点虽然已经落 PG，
普通 GET 只放行该检查点、过滤掉其 proposal；渲染器找不到工具名称和参数，工具消失。
隔离 PG 复现：相同运行中 `bash`，覆盖位置为 0 时 `tools: []`，覆盖 proposal 后为 `["bash"]`。
持续连接的 SSE 或最终 Tool result 可能补上显示，所以成功终态测试会漏掉这一窗口。

改善方向：在任务/请求身份边界关联 sampling，保证没有 partial、恢复快照及重复终态也能正确完成。
正在运行 Tool 的查询应连同它已经持久化的 proposal 一起读取，不能依赖先收到文本或观察事件。
继续使用原生记录和稳定 Task ID，不增设 Tool 结果账本。

### R06-03 · P2：PG 锁连接丢失后，Volume Gateway 仍能继续文件写入

位置：`packages/sandbox-control/src/postgres-workspace-volume-gateway-lock.ts:13`；
`packages/sandbox-control/src/persistent-volume-workspace-volume-gateway.ts:459`、`:556`。
默认及分布式 Helm 配置均支持两个 Volume Gateway 副本。

当前 advisory lock 连接出错时，只设置 `discard`，等待 `run()` 返回后才拒绝成功结果。
PG 已经释放锁，但旧进程的文件操作仍在执行。另一个副本可以拿到同一把锁并开始写文件。
最终报错能够阻止错误确认，不能撤回已经发生的文件写入。

复现使用真实隔离 PG、两个独立锁实例和临时文件：旧调用读文件后暂停，终止它的 PG
连接，新调用取得锁并完成写入，旧调用恢复后覆盖新内容。观察到：

```text
old-entered → new-entered → new-committed → old-wrote-after-lock-loss
oldResult = rejected
newWriteRetained = false
```

复现证明当前锁抽象不能跨连接丢失保护外部副作用；没有对生产凭据或生产 Volume 做故障注入。
实际源码中 Git 凭据授权/解除采用“读旧集合、改集合、写临时文件、rename”的方式，依赖此互斥。
仅同一实例的本地队列会继续串行，问题涉及独立副本之间的接管。

改善方向需要明确文件侧保护：优先评估与现有 POSIX Volume 插件一致、由存储端保持的锁或
具有原子版本条件的更新。连接丢失时取消工作有帮助，但“写前再查一次 PG”仍有检查与写入的间隙，
不能作为完整修复。保留 PG 生命周期授权和 Volume 的唯一字节权威；选定锁范围/接管协议后先记 ADR。

### R06-04 · P2：会话树读取把完整历史正文搬进 Control Plane 后才筛选

位置：`packages/control-plane/src/conversation-tree-service.ts:190`、`:395`、`:421`；
`packages/pi-session-postgres/src/durable/history.ts:50`。

`sessionEntries()` 以 `Number.MAX_SAFE_INTEGER` 作为读取上限，加载整条分支的 native Entry
正文，包括大量只供模型使用的 Tool 结果，随后才挑选会话树需要的用户消息和最终回答。
10,000 个树节点的限制在转换之后检查，不能约束前面的数据库传输和内存开销。
UI 在回合结束时还会刷新会话树。

隔离 PG 的实际 `ConversationTreeService.tree(...,"focus")` 复现中，接口只返回 **1 个节点**，
却读取了 **258 条正文、1,107,460 字节**。其中 256 条是每条 4KiB 的 Tool 结果。
这是固定夹具的读取量，不是线上容量或吞吐结论；它说明开销随无关工具历史增长。

改善方向：在 SQL 中依据原生索引和 Turn 关联筛出树所需的条目，再读取必要正文；
对展开节点/历史窗口分页，Fork/Prune 也单独读取指定锚点与范围。查询摘要可以是可重建索引，
不复制完整 transcript，不改变原生模型上下文，也不通过重新增加会话总量配额解决。

### R06-05 · P3：维护文档仍同时描述两套取消语义

`docs/ARCHITECTURE.md:91` 附近仍说原始回包 waiter 保留、等待十秒、由 native hooks
处理取消后的原始结果。ADR-0229 和现有实现采用 Durable abort：原生取消可以先终结，
晚到物理回包不会覆盖原生终态。文档后面的 Durable 小节与前面的旧说明互相矛盾。

`docs/README.md`、ROADMAP 的旧取消/暂停队列条目也需要明确其历史状态；
`scripts/experiments/pi-durable/README.md` 仍用现在时称生产版本是 0.84.1。
旧报告和历史实验本身可以保留，入口必须标明版本和已被替代的语义，不能让读者把两者组合成当前设计。

## 未通过的交付检查

### Q06-01 · P2：一个真实 Kafka 子 Agent 集成夹具没有完成 Durable 迁移

`packages/control-plane/test/subagent-views.integration.test.ts:123` 仍将随机 UUID
作为 `toolCallId`；当前 `SubagentController.#invocationEnded()` 要求 `task:<数字>`，
将旧值转换成 `NaN` 后触发 PG `22P02`，分区重试，测试等待回包超时。
该夹具的模拟 Worker 还没有处理新的 `prepare_conversation` 请求。

独立三副本 Kafka + PG 补跑共 7 个断言，**6 通过、1 失败**，失败正是此用例。
这不证明实际子 Agent 无法启动：本轮真实 Luna 父子并发路径成功。
它证明现有默认 skip 隐藏了一个失效的集成门禁，不能把全仓验证称为全部通过。

改善方向：移除旧 UUID Tool 身份夹具，用现有 native family fixture 模拟 Conversation 创建，
再验证控制变化唤醒等待者与空闲零 SQL。应在入口明确验证 native 身份格式，
避免把内部契约错配留给 SQL 转型和无限分区重试；不增加旧格式兼容。

### Q06-02 · P2：当前依赖审计被 source-map-js 1.2.1 阻断

`package-lock.json` 固定 `source-map-js@1.2.1`，来自 Vite/Vitest 的 PostCSS 开发依赖。
本轮 `npm run security:audit` 退出 1，保留一个 high 项；不是旧的 brace-expansion 项再次出现。
GitHub 公告将 `<1.2.2` 列为受影响版本，修复版本为 1.2.2。
参见 [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
和上游 [1.2.2 修复发布](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2)。

这里确认的是版本命中与交付门禁失败，没有证明生产聊天接口存在可利用路径。
改善方向是更新锁定的传递依赖，重新验证构建、浏览器和依赖审计；不应关闭审计或加忽略规则。

## 测得的优化机会

### O06-01：原生文档投影仍有可合并的 SQL 往返

`DurablePostgresProjection.#indexBatch()` 对每次文档变化先 `get(id)` 读取定义，再
`latestRevision(id)` 读取上次修订，然后写入修订。十次单文档 delta 的实测均为
**10 条 SQL，包括 BEGIN/COMMIT**。这是存储投影适配器的成本，不包含生产外层
Run/lease/offset 等额外语句，更不等于整个回合只有十次数据库访问。

优先在同一事务内批量读取定义/修订和批量写入索引，避免每项逐一查询。
真正需要的权限、封口和并发边界仍保留。不要因为 ingress 普通 append 已经零 SQL，
就把整个 Projector 也描述为零 SQL；也不应为消灭查询新增第二个权威存储。

### O06-02：参数化 JSON 字段名在 generic plan 下不能稳定使用表达式索引

`postgres-projection.ts:101` 将 `conversation` 等固定索引键写成参数。
`database/client.ts` 会为 SELECT 命名 prepared statement。
在 20,000 条记录的夹具中，强制 generic plan 的动态键查询过滤掉 19,990 行；
把代码拥有的键写成 SQL 常量后使用 Conversation 表达式索引，只访问目标范围。

本次默认 `auto` 计划 **12 次均使用 custom plan，generic 为 0**，没有证据表明默认线上已经退化。
因此这是一项查询计划稳定性优化。耗时及 buffer 计数见 JSON 记录；它们受同机负载影响。
采用固定键白名单和对应查询形状即可，无需关闭所有 prepared statements 或新增缓存服务。

### O06-03：Guest 为三个截断 helper 引入了完整 CLI 的大量依赖

`tool-sandbox/src/native-tools.ts` 和 `native-tool-output.ts` 只需要截断函数和常量，
却从 `@earendil-works/pi-coding-agent` 根入口导入。按照现有构建选项，
`envd-tool-exec` bundle 为 **8,782,025 字节**，保留了 Pi AI、多个 Provider SDK、TUI、
MCP、Codemode 等代码。其中 Pi MCP 为 81,087 字节，Pi Codemode 为 36,904 字节。

只在诊断构建中将该入口替换为原发行包的截断文件，bundle 降到 **774,039 字节**。
诊断没有输出或执行生成文件，也没有更改运行时代码。此结果证明依赖入口造成的膨胀，
不证明 MCP 已经启用，也不是启动时间或内存性能测量。

生产修复应优先采用上游公开的窄导出；当前 Durable tools 没有对应截断导出。
若需要在 PiCloud 自己的输出适配器保留小型实现，应说明来源并用上游行为做契约校验。
不要把诊断中的私有深层导入变成生产依赖。

## 对架构的评价

- **原生与云端的职责划分值得保留。** Harness 决定原生 Task 如何执行、重试、压缩和取消；
  PG 决定哪个 Worker 有权执行与恢复。二者处理不同的问题。不要让 native reopen 绕过新授权，
  也不必为每个 native Task 再建一套云端工作流状态机。
- **Kafka 有序变更与内存视图适合当前路径。** 绑定变化、封口和工具意图经过相同 Session 路径，
  消费者从持久化状态和有序后缀恢复视图。必须保留入口撤销与目的端 fencing，
  单靠“迟早会消费到关闭消息”不能撤销已经失效的外部执行权限。
- **一个物理 Session 的单 writer 是一致性取舍。** 多 Conversation 并行不代表拥有独立写入权。
  writer 提交不确定时影响同一家族，是当前原子历史的故障边界；目前没有证据需要改成多 writer。
- **PG 日志索引合理，访问方式仍需打磨。** 正文只存一次、索引可重建没有引入第二份执行事实。
  R06-04 和 O06-01 应先改善查询/批处理，避免为读取性能增加另一个历史存储。
- **外部副作用的 UNKNOWN 边界诚实。** Projector 先确认 dispatch offset，再调用 Cube，
  中间崩溃可能使执行未发生或不可确认。恢复不能任意重发 shell。不要把这一选择宣传成
  任意命令 exactly-once；要继续验证漏确认、取消和旧 owner 的具体边界。
- **部署集中降低运维成本，也共享资源压力。** API、Projector、生命周期控制在同一服务中，
  大历史读取和大量逐条 SQL 会影响其他工作。先修已测出的热点，再依据混合负载决定是否拆进程。
  现阶段没有依据新增 Broker、Redis、调度框架或另一个 Kafka consumer group。
- **Cube 定制接口已经是维护责任。** 当前声明式发布通过统一 Helm post-renderer 产生期望状态，
  之前“Helm 后再临时 patch”的故障不能直接算作本轮新问题。原生执行、allocation 关闭、
  Volume 引用恢复仍需固定上游版本、匹配发布及契约测试；不能把这些内容概括成一个 Node 转发器。

背景压缩关闭、Tool 进度只走 HTTP/SSE、未完成 Tool call 不持久化、Stop 后排队消息回输入框，
都是已有明确依据的产品选择。MCP、Codemode 和用户扩展不是本轮必须接入的能力。
它们与上游默认行为不同，不自动构成缺陷；Guest 的依赖膨胀则是可以独立处理的工程问题。

## 覆盖与验证

| 范围 | 覆盖内容与工作区 |
| --- | --- |
| 原生运行时 | `sandbox-supervisor`、`supervisor-host`：公共 Harness/Models/hooks，恢复、输入、取消、模型 permits、Worker 接管 |
| 存储与附件 | `pi-session-postgres`、`database`、`session-attachments`：prepare/ACK/adopt，索引、文档修订、原生历史、图像引用与 GC |
| 有序传播 | `runtime-core`、`event-log`：入口、事务 fencing、封口、Projector、回包 mailbox、offset/replay 边界 |
| 工具与 VM | `sandbox-control`、`tool-sandbox`、`cube-completion`、`workspace-runtime`：执行、进程组取消、故障探测、allocation、Volume、上传 |
| 产品流程 | `control-plane`、`subagent-control`、`web-ui`：队列、Steer、子 Conversation、Fork/Prune、删除、快照/SSE、资源和源码托管入口 |
| 协议和领域 | `protocol`、`domain`：身份、边界预算、状态、公开 schemas 与 native 类型隔离 |
| 网关 | `provider-egress-relay`、`cube-egress-gateway`、`cube-api-authorizer`、`ssh-gateway`：凭据边界、授权和终端/代理传输 |
| 观测与夹具 | `observability`、`fake-model-server`：日志和指标、观测不作为执行权威、可控错误/取消夹具 |
| 交付与文档 | scripts、Helm、Dockerfile、Cube 有效补丁源码、当前 ADR、README/架构/路线图；固定依赖与构建入口 |

主验证结果：

- 隔离 PostgreSQL 下 `npm run check`：**1,645 项通过、9 项可选集成跳过**，包含所有工作区
  typecheck 和 53 项 acceptance helpers。跳过项另行记录，不能混称全部集成已通过。
- 独立 RF3 Kafka + PG 补跑其中 7 个断言：**6 通过、1 失败**，见 Q06-01。
  普通 ingress append 的 12 个样本 SQL 为 0；100 次热绑定读取 SQL 为 0，
  关闭通知 ACK 丢失/恢复与有序操作取消检查通过。该补跑不包含两项可选 Cube live gate。
- 故障清单：**190/190 通过**；这是确定性故障测试，不是生产分布式 chaos 或多机 HA 证明。
- 新增复现：真实 native Harness 压缩恢复、terminal-only 显示事件、真实 PG 工具快照、
  会话树读取量、文档投影 SQL、查询计划、PG 锁连接丢失，以及实际 Guest bundle 依赖测量。
- 浏览器 presentation 检查通过：含队列/输入、快照、附件、资源重新绑定和终端生命周期等。
- 真实 GPT-6 Luna：一次 write + Bash SHA-256 验证通过；67 条 native writes 中有 33 条文档写入，
  文档中 Tool call 为 0，完整 Tool call 和 execute checkpoint 各 2 个。
- 真实 GPT-6 Luna：父 Agent 并发两个子 Agent 成功；同一物理 Session、同一 owner、不同 native Conversation。
  两组测试均通过 API 清理自身会话和 Workspace。
- 只读部署检查：两个 Worker ready，使用 `complete-tools-af011ea46133`，schema 180。
  检查时 active/unsealed Run 为 0；两个既有 UNKNOWN runtime 保留，未用猜测释放配额。
- build、依赖固定检查、Helm/install/runtime/observability 和镜像闭包检查通过。
  Cube 原生 admission race、真实 MySQL/Bolt allocation/Volume 契约检查通过。
  `security:audit` 未通过，见 Q06-02。完整状态见配套 JSON 验证记录。

本轮不重启共享生产服务，不改生产数据格式。既有 Template GC 超时和历史 UNKNOWN allocation
继续列入 backlog；未将旧缺陷或已接受的保守状态重复列为新发现。

复现入口在
[`scripts/experiments/review-durable-20261006/`](../../scripts/experiments/review-durable-20261006/README.md)。
完整的脱敏结果见 [验证记录](repository-review-20261006.json)。
新复现刻意保留当前失败行为作为审查证据，不把“脚本退出 0”解释成对应产品问题已经修复。

建议实施次序：修复 Q06-01/02 让交付检查可信，同时优先处理 R06-01/02 这一组原生恢复与显示适配；
再确定 R06-03 的文件侧保护，随后收窄 R06-04 与投影查询成本，整理依赖入口和维护文档。
每个改动保持独立、完整的验证切片。
