# 审查后续：结果预算、租约观察和组件边界

日期：2026-09-27。基线：`50da2c6e`。
状态：实现、验证、本地匹配部署和真实验收均已完成。
最终实现提交：`ac763dbf6eefafc3740aa1ba32171ce941726d5a`；前两片实现分别为
`1da62737`（结果预算）和 `c82d1e56`（租约观察）。

用户确认后，原审查 D1 按正确性缺陷处理，D3/D4 按保持语义的内部重构处理。
D2 的意图/命令合并和通用大结果附件能力仍待讨论。
D5 随后完成[索引日志切换与验收](indexed-native-log-acceptance-20260927.md)。

## D1：先保证结果能进入原生历史

- 保留执行日志的 900 KiB 整条记录上限。Subagent 文本以 JSON 编码后的 UTF-8
  字节计数，预算为 256 KiB，给原生消息、展示事件和身份元数据留出空间。
- 固定 Guest workflow 包装、Broker 接收端和 Worker Tool 使用共同预算。
  `contact_supervisor` 和 `subagent_supervisor` 还检查整个结果，包含可能重复的 details。
- 超限产生明确的 `subagent_result_too_large` Tool 错误。正常的小字符串和 JSON
  保持原样；不把结构化结果截断成成功，不隐式存入另一种附件，不自动重复已发生的效果。
  错误会提醒检查既有结果，并显式返回摘要或 Workspace 文件路径。
- 原生 Pi 仍完成错误处理、after-hook 和 canonical 写入。测试确认错误能持久化，
  随后的模型步骤可以继续，脚本写入的标记只有一次。

决定与验收合同见 [ADR-0196](../adr/0196-bounded-subagent-results.md)。

## D3：共享观察，保留失效判断

`PostgresSessionLeaseObserver` 替代逐 Session 的独立轮询对象。一个 Worker 用一条查询
检查当前观察的所有 owner，正常稳态从 N 个 Session 的 N 次读取变为一个批次。
首次打开的并发读取也能合并；过期缓存需要刷新时仍允许立即读取。

PG 心跳提交后的续租证据进入同一缓存。周期观察仍按一秒间隔调度，而非等到较慢的
续租周期才发现撤销。请求发起时的单调时钟界定剩余有效期；网络等待不延长它。
旧查询不能覆盖更新的确认，迟到确认不能恢复已经中止的观察；不同租户、Session、
lease 和 fence 不共享授权。一次查询失败会中止该批次涉及的 owner。

Native Host 仍管理父子 Lane 引用计数。关闭一个 Lane 不关闭其兄弟，冷恢复的旧缓存
会先刷新再判断。PG 授权、失效/封口、单 writer 和 Broker 的独立 fencing 均保持原合同。

## D4：按调用职责整理依赖

- `subagent-control` 只保留 PG 子任务与父子通信协调。旧 `trusted-tool-runtime` 包名
  和旧出口删除，全部调用点迁移，没有兼容别名。
- Pi Tool 定义和每 Run 装配移至 `supervisor-host/src/tools`。控制面的生产依赖闭包
  不再包含 `sandbox-supervisor`，镜像也不再复制 Runner 源码。
- 原生 checkpoint/append 接口归内部 `protocol/native-session` 入口；Runner 不再
  为接口依赖 PG 实现包。该入口没有变成 HTTP 公共协议，原生日志内容和序号不变。
- Workspace seed 和 Guest 目录规则独立于模型/API schema。Guest 使用窄协议入口，
  Docker 只复制所需的 11 个协议文件。真实 esbuild 打包验证闭包；模型目录修改不改变
  Guest 身份，复制的工具/协议内容修改仍会改变身份。
- 构建摘要算法、基础镜像、实际 image digest 和 Cube READY 校验不变。共享 manifest
  和锁文件仍是保守构建输入；没有通过忽略真实输入来复用模板。

控制面仍会使用原生历史处理所需的 Pi SDK 功能；上述解耦针对具体 Agent Runner，
不把它表述为“API 镜像完全没有 Pi SDK”。

拆分还发现并修正了安全依赖准备脚本的隐含条件：Nest 的补丁不应因没有安装
Pi Coding Agent 而被跳过。现在按实际安装的组件分别准备，并支持 npm 的根目录和
Control Plane 工作区布局。没有升级 Pi 或其他运行时依赖；esbuild 仅把已使用的
0.28.1 显式声明为验证工具依赖。

## 验证与部署

[验证附件](repository-review-followup-verification-20260927.json)按文件汇总最后一次结果，
保存受影响源码的 SHA256，不重复计算重叠执行：21 个包、198 个测试文件，
**1,184 通过、118 个默认/opt-in 跳过**；另有 **40/40** 验收辅助测试通过。
全工作区类型检查、镜像依赖闭包、构建上下文、运行策略、文档/格式和依赖硬化检查通过。
依赖安全检查通过 high/critical 门槛，仍保留之前已知的两项 moderate 开发测试依赖发现。

验证不是一次完整绿色的 `npm run check`：初次并行验证遇到夹具初始化超时并停止；
后一次命令重复传递 maxWorkers，八个工作区在执行测试前拒绝了参数，随后使用各自的
维护命令补跑。资源压力下失败的九个文件，最终串行复测 **131/131** 通过；支持外部
数据库的场景使用独立真实 PG。原生 Harness 的 30 秒初始化预算和 Preview 的 20 秒测试预算最终保留原值；
移动后的 Preview 清理预算沿用原包的 60 秒。没有放宽运行时租约、工具期限或业务断言。
大输出测试移除了“命令必在一秒内结束”的环境假设；最终输出边界和独立的进度频率断言保留。

[故障矩阵](repository-review-followup-faults-20260927.json)增加七项针对性用例，
**72/72** 通过，相关并发场景使用独立真实 PostgreSQL。执行时记录的是提交前的
`c82d1e56` 加 dirty 标记；随后提交没有改变被验证源码，验证附件记录最终文件摘要。

[匹配部署](repository-review-followup-rollout-20260927.json)确认 Control Plane、两个
Worker、Broker、Web 均运行 `ac763dbf` 镜像且健康，关键源码摘要一致。API 镜像没有
Runner 源码，其 Nest 实际使用的 `find-my-way` 为 9.7.0。Guest 构建身份为
`dbcdd74b623a27ffbdf266c706e2e09331c0532c`，四种 Cube 模板均匹配且 READY。
数据库仍为 `152_editable_pending_inputs`；PG/Kafka 等数据服务未重启。

[真实 GPT-6 Luna/Cube 验收](repository-review-followup-live-20260927.json)：

- workflow 写入一次标记后返回 1 MiB，得到已持久化的明确 Tool 错误，Run 正常完成。
- 两个 Child 与 Parent 共用 Worker、物理 Session 和租约；跨过约 20 秒的续租后正常结束。
- 原样执行随机数字图片生成命令，再调用 read；Luna 正确识别 **3,208,454 字节** PNG
  中的四位数字。期望值通过独立 Workspace 读取比对，生成命令没有向模型输出数字。
- read/write/edit/bash、1.5 MB 输出的有界结果、Guest `/tmp`、相对路径和符号链接回归通过。

八个验收 Run 全部完成，两个 Workspace 的存储已清理，父子 Session 已归档，临时
PostgreSQL 已删除。全局未完成 Run、未释放租约、未封口 Session 均为零。
归档历史仍按合同保留其图片引用。旧模板清理删除四个模板，11 个旧节点清理超时仍按
既有运维 backlog 延期；没有绕过删除保护。这是本机两 Worker 的验收，未声称多机 HA。
