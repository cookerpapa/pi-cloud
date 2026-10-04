# 全仓复审：生命周期、Pi 对齐与跨组件契约

审查基线：`8d8ee83723bb236d6f5d820fb21a5783f95c6711`，2026-10-04。
本轮交付审查结论、复现工具和测量证据。没有修改产品运行时代码、Cube 补丁或生产部署。
实机复现只创建了一个本轮专用 Cube，完成后恢复并关闭，确认记录节点上的 VM 已不存在。

## 结论

发现 **7 项明确问题，其中 2 项 P1；另有 1 项浏览器验证缺口**。
既有全仓测试和 178 个故障用例通过，但没有覆盖这些组合边界。

Pi 管理 Agent Loop，PG 管理 Run/控制状态，Kafka 承接有序发布与投影恢复，
Cube 承接执行，Volume/S3 分别管理 Workspace 与会话图片，这个职责划分可以保留。
主要缺陷出现在同一约束跨组件传递时：删除预算、恢复过程中的内存状态、清理回执、
控制权判断、模型请求选项和错误分类。修复应先围绕这些边界收敛。

| 编号 | 优先级 | 问题 | 证据 |
| --- | --- | --- | --- |
| R04-01 | P1 | 暂停的 VM 无法通过新 allocation Close 正常释放 | 真实 Cube：连续三次失败，VM 仍暂停；显式恢复后可关闭 |
| R04-02 | P1 | 恢复中途失败留下已脱离 Provider 的句柄，后续巡检可使控制面进程退出 | 两类恢复复现、实际健康巡检子进程退出 |
| R04-03 | P2 | VM 已删除但节点回执落盘失败，可永久留下 Volume 引用计数 | 真实 Bolt 故障注入与真实 MySQL 状态验证 |
| R04-04 | P2 | 控制面所有权读取后失效，资源变更仍可提交 | 当前完整 schema 的 PostgreSQL 交错复现 |
| R04-05 | P2 | Fast 模式的自动 Compaction 遗漏服务档位，被网关拒绝 | 原生 Pi Compactor、CloudAgentRuntime 与请求策略对照 |
| R04-06 | P2 | 普通 Bash 错误文本会被误识别为基础设施故障 | 实际固定 Bash Tool 与 Worker 适配器对照 |
| R04-07 | P2 | SSH 凭证有效期依赖网关本地时钟，可接受 PG 已过期凭证 | 窄表真实 PG 与正反时钟对照 |
| Q04-01 | 验证缺口 | 完整浏览器检查仍使用旧队列协议，无法完成 | 原入口失败；仅修正临时夹具后交互通过 |

本轮没有证明用户会话数据丢失、任意 Shell 自动重放或新旧控制器同时执行同一个 Shell。
下面每项明确说明实际证明到哪一层。

## 覆盖与方法

[覆盖清单](repository-review-20261004-coverage.json)记录基线的 1,485 个跟踪文件、
22 个工作区、365 个运行时文件及 103,121 行运行时内容，包括文件摘要和静态导入。
包级导入图没有发现环。清单扫描不等于每一行经过人工证明；人工沿下列边界展开。
历史迁移通过当前 schema 建库验证，历史报告按其版本使用。Pi 比较以安装的
`@earendil-works/* 0.84.1` 为准；Cube 比较以固定上游提交及四份补丁为准。

| 范围 | 展开的边界 |
| --- | --- |
| sandbox-control、Cube 补丁 | 创建授权、固定节点/boot、关闭、暂停/恢复、持久回执、孤儿回收、恢复缓存、健康巡检、共享 VM 与 Volume 边界 |
| sandbox-supervisor、supervisor-host | 原生工具校验/hooks、取消与排队输入、冻结采样、重试/Compaction、模型许可、错误收尾、Worker 启动与回包生命周期 |
| runtime-core、event-log | ingress 软状态、同队列封口、事务生产者、dispatch commit、重放、分区换主、Outbox、取消及 Worker-boot 回复 |
| pi-session-postgres、database | 单 writer、分支冷读、Compaction、幂等投影、锁后快照、不可变 payload、删除与投影重建、当前 schema |
| control-plane、subagent-control | 接收/停止/恢复输入、队列视图、子任务准备与结果、会话树、Workspace 绑定、代码托管协调与租户约束 |
| session-attachments、workspace-runtime、tool-sandbox | 图片引用与 GC、上传双写/取消、流式校验、文件落盘与幂等放置、原生文件与进程组语义 |
| web-ui、protocol | 流式快照、重连、草稿/输入队列、切换会话、附件、模型设置、预览/终端、协议校验 |
| ssh-gateway、cube-api-authorizer、cube-egress-gateway、provider-egress-relay | 凭证消费、终端连接收尾、管理接口范围、代理连接和内部/外部传输边界 |
| domain、observability、fake-model-server | 配额/状态策略、观测与权威的区分、指标标签、日志、合成模型与真实运行路径的隔离 |
| scripts、Dockerfile、Helm、CI、文档 | 发布来源、配置渲染、镜像输入、原生版本校验、验证入口、旧术语与当前拓扑 |

原生 Cube 的检查集中于补丁触及的分配、执行、删除、Volume 和发布契约，不代表审查了整个
Cube 上游产品。已确认的架构约束按 ADR 保留，没有把缺少用户扩展、持久审批 UI 或物理节点
HA 直接列为实现缺陷。

## R04-01：五秒查询预算被用于暂停 VM 的物理删除

位置：[allocation 补丁](../../deploy/cubesandbox/patches/0004-recoverable-vm-allocation.patch)，
补丁行 4280，`CubeMaster/pkg/service/sandbox/allocation.go::ReconcileAllocation`；
固定上游 `Cubelet/services/cubebox/delete_resume.go::newDeleteDeadlineBudget`。

Master 给 `ManageAllocation` 的统一 RPC 预算是 5 秒。Close 把这个上下文传到原生
Destroy。原生 Cube 删除暂停 VM 前，需要至少 1 秒恢复、5 秒清理和 1 秒响应预算，
因此每次都在恢复前拒绝；重试仍拿到相同的不足预算。

例子：开发机处于暂停状态，用户直接点击释放。PG 已记录不可逆关闭意图，物理 VM 却一直
暂停，资源和配额不能释放。上轮验收执行的是“暂停 → 恢复 → 释放”，没有覆盖直接释放暂停 VM。

[实机证据](repository-review-20261004-paused-allocation.json)：三个 Close 请求分别在
183/38/36ms 返回 HTTP 500，之后 VM 仍为 `paused`。仅对测试 VM 显式 Resume 后，Close
完成并确认节点不存在。这不是正常删除较慢，而是调用预算存在确定性冲突。

建议：查询/探测预算与已接受的物理清理预算分开定义，按原生暂停删除契约传播 deadline。
补上 paused→release、关闭期间丢回包、清理超过查询预算的组合测试。是否让已接受清理独立于
请求连接继续完成，属于 Cube 生命周期协议的明确选择，不能只在某一层盲目增加超时。

## R04-02：恢复失败没有回滚已经发布到本地的句柄

位置：[SandboxController](../../packages/sandbox-control/src/sandbox-controller.ts) 645、671、813、821、3020；
[RuntimeHealthMonitor](../../packages/sandbox-control/src/runtime-health-monitor.ts) 37、46。

开发机恢复先把句柄放入 `#developmentEnvironments`，随后恢复绑定。绑定读取失败时，catch
把句柄从 Provider 脱离，但没有移除控制器 Map。弹性 VM 在最后一次 PG 状态写入前放进
`#warm`，该写入失败时也会留下同类状态。

下一次恢复把这些 Map 中的 ID 当成“已经恢复”，从候选中排除。Provider 已经没有句柄，
控制器却报告它活跃。健康巡检枚举目标时调用 `executionIdentity`，实际 Provider 的
`#localOwned` 会抛错；定时器对这一枚举异常没有隔离，错误可以退出整个控制面进程。

证据：[两类恢复复现](../../scripts/review-20261004-recovery.test.ts)证明第一次恢复失败后
`activeCount=1`、Provider 已脱离，第二次恢复不再尝试 adoption，读取执行身份会抛错。
[巡检子进程](../../scripts/review-20261004-health-crash.mjs)使用实际 `RuntimeHealthMonitor`，
目标枚举失败导致退出码 1。后者不是在生产控制面注入崩溃。

建议：把恢复当作分阶段提交，完成绑定与必要持久化后再发布本地可用状态；失败时撤销本次新增的
Map、绑定与容量登记。巡检枚举的单个资源错误也应有资源级隔离。已有测试中忽略候选排除列表的
mock 需要修正，否则会掩盖“下一轮根本不会再次恢复”的问题。

## R04-03：清理结果丢失后，确认不存在仍不能重建 Volume 记账

位置：[allocation 补丁](../../deploy/cubesandbox/patches/0004-recoverable-vm-allocation.patch)
7916、8400、3731–3735；对应节点 `Manager.Close/cleanupAllocation` 和 Master `Store.Finish`。

失败窗口是：原生删除已完成，返回了 Volume 最后一个引用释放事件，但节点把这个结果写入
allocation journal 时失败。重试发现 VM 已不存在，直接返回记录里的 `CleanupResult`；
这个字段恰好还没写成功，因此是空的。

Master 随后把 allocation 标成 `absent`，并把 `CloseRefsApplied` 标成 true，但没有执行引用
计数减一。Volume 删除接口仍因 `refcount=1` 拒绝清理，普通 allocation 重试也不会修复该计数。

[节点复现](../../scripts/review-20261004-cube/node_receipt_test.go)在真实 Bolt 上注入一次
清理结果写入失败；物理清理回调被替身模拟。[Master 复现](../../scripts/review-20261004-cube/master_receipt_test.go)
用真实 MySQL 验证最终 `absent + CloseRefsApplied=true + refcount=1`。
这给已有“Volume 引用漂移”待办补充了明确原因，不能声称已经定位所有历史漂移。

建议：补齐从节点物理状态到 Master Volume 状态的收敛契约。可以讨论保留回执直到 Master
确认应用，或依据节点上的实际 Volume 引用状态重建；后者对历史回执丢失更有恢复能力。
回执按时间 GC 后的记账恢复也要覆盖。保持删除保护，不能把计数强制归零当成自动修复。

## R04-04：所有权检查与资源变更之间存在撤销窗口

位置：[WorkspaceRuntimeStateRepository](../../packages/sandbox-control/src/workspace-runtime-state-repository.ts)
438、488、2036。

`beginCreation` 和 `closeAllocation` 在事务内先普通 SELECT 校验控制器租约，再修改资源行。
该读取没有锁住所有权记录，资源变更语句也没有重新验证租约。两条语句之间控制器被标记为
lost，后一条语句仍能成功。

[真实 PG 复现](../../scripts/review-20261004-owner.test.ts)使用完整 schema，在所有权读取返回前
插入一个确定性交错：另一个连接把控制器标为 lost、租约设为已过期，随后原事务仍返回新的
创建授权，或提交不可逆关闭。测试没有让继任者先取得同一资源，因此不把结果夸大为“旧控制器
已经能覆盖新控制器的资源”。

建议：把资源锁、所有权身份和 PG 当前时间的校验放到同一个明确的授权边界，保留资源换主的
CAS 条件，并检查锁顺序。不能把“同一事务内读过一次”当成租约始终有效。

## R04-05：Fast 请求策略只覆盖普通采样，遗漏 Compaction

位置：[CloudAgentRuntime](../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts) 1123、1146；
[PiCloudTurnRunner](../../packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts) 899–906；
[ModelGateway](../../packages/supervisor-host/src/model-gateway.ts) 727–736。

普通请求通过 `streamOptions.onPayload` 写入 `service_tier=fast`。自动 Compaction 使用另一条
`Models.completeSimple` 路径，仅转发原生参数与 headers，没有应用这个策略。网关却要求同一个
Fast Run 的每次请求都携带该档位，因此第一次自动压缩会失败。

例子：短对话 Fast 使用正常，历史足够长触发压缩后，Run 因 `model_service_tier_mismatch`
失败；原上下文保留，但继续使用 Fast 又会遇到同一问题。

[复现](../../scripts/review-20261004-compaction.test.ts)运行实际固定版本 Pi Compactor 和
CloudAgentRuntime：普通请求有 fast，压缩请求没有；模拟与网关源码相同的拒绝后，Run 为 failed，
没有写入 Compaction Entry。没有为该复现发起付费模型请求。

建议：统一普通采样与维护请求的公共策略，包括档位、传输与必要超时，同时保留压缩专属的
token 预算、独立 Session ID 和 cache 策略。不要把 Hosted Tools 等普通采样选项直接全部复制给压缩。

## R04-06：工具文本被用作控制面的故障分类

位置：[trusted-remote-tools](../../packages/sandbox-supervisor/src/trusted-remote-tools.ts) 532–534；
[remote-tool-sandbox-turn-runner](../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts) 644–648。

Worker 从错误文本的第一个冒号前取“错误码”。普通 Bash 打印
`ownership_lost: ordinary application log` 后退出 7，也会触发 `onToolOperationUnavailable`。
Run 因而记录 Sandbox unavailable、停止后续采样，并安排未完成操作取消。

[复现](../../scripts/review-20261004-tool-error.test.ts)执行实际固定 Bash Tool：同样的失败命令，
普通前缀只产生 Tool error，`ownership_lost` 前缀却触发基础设施不可用回调。
这里只证明误分类和其确定的 Run 控制路径，不声称它直接销毁 VM。

建议：在 PiCloud 自有传输信封中明确区分基础设施失败与原生 Tool result，保留结构化错误码。
原生 Bash 的 stdout/stderr 继续交给 Pi 和模型处理，不能参与控制权或存活状态判断。
这涉及传输协议，修复前需要记录 ADR。

## R04-07：SSH 到期判断仍使用应用时钟

位置：[SshTicketAuthority](../../packages/ssh-gateway/src/ticket-authority.ts) 31、53；
[SshAccessTicketService](../../packages/control-plane/src/ssh-access-ticket-service.ts) 71–72。

签发与消费都使用各自进程的 Date 时间，消费端还在拿锁前采样。PG 已过期 60 秒的票据，
在慢 120 秒的网关上仍会被消费。该问题依赖时钟偏差或锁等待，不是当前单机环境必然发生的故障。

[复现](../../scripts/review-20261004-ssh-clock.test.ts)以真实 PG 的三张窄表隔离原查询：正常时钟
拒绝过期票据，慢时钟接受，数据库最终同时满足 expired=true、consumed=true。
没有连接真实 SSH 或 VM，也没有把窄表测试描述成完整认证验收。

建议按现有 PG 权威时间原则统一签发与消费，并在拿到相关锁后验证有效期。其他带租约的
产品集成路径也应按同一规则整理，避免每个适配器各自定义时间含义。

## Q04-01：完整浏览器检查使用了过期夹具

位置：[浏览器检查脚本](../../scripts/run-browser-presentation-check.mjs) 188、248、621。
`renderChat.getInputQueue` 返回旧结构，缺少 `viewVersion`、分页和暂停字段。
`PendingInputQueue.apply` 第二次处理快照时需要 `BigInt(viewVersion)`，因此原入口等不到待发送消息。

本轮原始 `npm run browser:presentation:check` 失败。[对照脚本](../../scripts/review-20261004-browser.mjs)
只在临时副本中补齐队列结构，随后原脚本覆盖的交互通过，产品代码没有改变。
这属于已有广泛浏览器验证待办的具体原因，不是新增的线上队列故障。

建议更新夹具并让返回值经过生产协议 parser，避免直接 monkey-patch API 方法绕过 schema。
修正前，不能把单元测试通过写成完整浏览器验收通过。

## 往返实测与精简候选

[SQL 明细](repository-review-20261004-sql.json)来自实际 `pg.Client.query` 计数，包含 BEGIN/COMMIT，
不包含触发器内部 SQL。执行后端被替身替代，不包含 HTTP 认证、Kafka、Cube 和模型耗时。

| 操作 | 客户端 SQL 往返 |
| --- | ---: |
| 首次接收输入 / 接收 follow-up | 7 / 7 |
| 相同幂等键重试接收 | 3 |
| Run 准入 | 11 |
| 读取队列快照 / 刷新队列内存视图 | 1 / 1 |
| 1,000 次队列缓存读取 | 0 |
| 1,000 次工具绑定内存查询 | 0 |
| 接收 Stop 并暂停未执行输入 | 9 |
| 替身后端收尾 | 19，含一条测试用 drained UPDATE |

[数据路径测量](repository-review-20261004-data-paths.json)也确认：队列为 10/100/500 条时，
首页返回 10/20/20 条；100 与 500 条的首页均约 86KB。一次仅修改名称的 native append，在
1/101/1001/10001 个 Lane 下均返回零个 Lane head、两个字节的空数组，没有恢复全量 head 回传。
这些是固定工作负载的观察，不是容量或端到端延迟结论。

可继续评估的精简点：

1. 接收输入时模型配置与环境配置分别读取，可研究在既有锁后合成一个配置快照，候选收益是少一次往返。
   模型启用、凭证版本和 Workspace 准入仍由 PG 决定。
2. 收尾中的相似租约读取涉及不同阶段与有效期规则，应把职责和所持锁写清楚后再判断可复用部分。
   本轮没有证明这些确认可以直接删除。
3. [构建输入对照](repository-review-20261004-build-coupling.json)表明：只更换测试 MySQL 镜像，
   native patchId 也会变化，尽管四份生产补丁完全相同。测试镜像 pin 应与生产版本身份解耦；
   `build-cubesandbox-runtime.mjs` 当前把整份 manifest 纳入摘要。
4. 若模块只需要 `ControlPlaneStoreError`，可以直接依赖已有的小错误模块。
   `api-exception.filter`、`ssh-access-ticket-service`、`development-environment-service`、
   `conversation-tree-service` 仍通过较大的 Store 入口取得它。这里没有声称发现运行时依赖环。
5. `SessionProjector` 构造器里的“Run settlement never waits for their completion”注释需要按
   ADR-0221 澄清：最终 seal 的路由撤销与此前等待原 Tool 取消结果是不同阶段。
   历史报告和必要迁移保留其版本语义；旧名字本身不是删除依据。

## 架构评价与需要讨论的部分

**Pi 对齐的主体边界成立。** 当前使用原生 Agent、校验和 hooks，云侧封装持久化、控制输入与
环境事实。已有六项 Pi 对照探针未发现旧问题复发。审批可以利用原生 hooks 扩展，但其持久化、
恢复和 UI 仍是待设计产品能力，不能称为当前已经支持。

**Kafka 内存视图的优化有效。** 工具路由的热查询与队列缓存命中都不访问 PG。PG 保留准入和
生命周期判断很有必要，R04-04 正说明这些判断必须有严谨边界。重放不重新执行 Shell、提交与
外部效果之间保留 UNKNOWN，是当前明确选择，不是可以凭空消除的分布式窗口。

最值得讨论的是三项：

- **Cube 清理与 Volume 记账的恢复协议。** PG 产品意图、Master 放置记录、节点执行记录各有
  职责，但终态回执丢失后的收敛还不完整。需要在回执确认与状态重建之间作出明确选择。
- **控制面的故障隔离。** API、ingress、Projector、生命周期控制共享进程降低了部署和转发成本；
  R04-02 展示了资源级恢复错误怎样扩大影响。先补资源级异常隔离和恢复提交边界，再依据混合负载
  与可用性实测决定是否拆进程。
- **Cube 定制接口的维护范围。** 现在包含分配、执行、取消、回包、观察和持久化契约。
  应把上游化、版本升级契约和真实生命周期组合测试列为长期维护工作；小型 Manager 单元测试
  不能替代与 Cube 原生暂停、删除预算及存储实现的组合验证。

## 验证记录与边界

[机器可读验证记录](repository-review-20261004-verification.json)汇总命令、结果和范围。
[最终只读盘点](repository-review-20261004-final-inventory.json)确认没有本轮遗留 VM 或
待执行/运行中的 Run，两条历史 UNKNOWN 记录保持原样。

- 全仓 `check`：1,741 项通过，9 项外部服务测试按默认配置跳过。
- 故障清单：当前干净基线 [178/178](repository-review-20261004-faults.json)。
- 既有 Cube allocation 9 项、admission/cancellation 15 项通过；新增回执特征测试 2 项通过。
- 新增特征测试验证的是基线缺陷确实存在，不能当作正确行为的回归规格；应随修复改为正确行为断言。
- 文档、时间预算、安装契约、Helm、观测配置和镜像依赖闭包检查通过。
- Web 构建与部署契约通过；原完整浏览器入口失败，修正临时夹具后的对照通过。
- 依赖审计按仓库 high/critical 门槛通过；Fastify 及其 Nest 适配器仍有 moderate 标记。
- 本轮没有追加付费 LLM 请求、破坏生产节点或做多机 HA/断电测试。原生行为使用固定 Pi 和合成模型，
  真实 VM 用于暂停关闭边界；上轮 Luna 验收保持为其版本上的历史证据。

建议先处理 R04-01/02，再按模型请求、工具错误协议、权限时间、存储收敛分别实施小的修复切片。
涉及持久化或协议选择的变更先记录 ADR，其余修复保持当前架构约束。
