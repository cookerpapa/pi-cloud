# 审查后续：结果预算、租约观察和组件边界

日期：2026-09-27。基线：`50da2c6e`。
状态：实现和定向回归完成，全仓复测与匹配部署正在收尾。

用户确认后，原审查 D1 按正确性缺陷处理，D3/D4 按保持语义的内部重构处理。
D2 的意图/命令合并、D5 的存储布局以及通用大结果附件能力仍待讨论。

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

全工作区类型检查、40 项验收辅助测试、镜像依赖闭包、构建上下文和文档/格式检查已通过。
测试执行中的资源争用、初始化超时与 CLI 参数错误会在最终验证附件中单独记录，
不将未执行或超时用例计作通过。原有故障矩阵加入七项针对性用例，总计 72 项。

最终全仓复测、真实 PG 故障回归、Luna/Cube 验收和部署标识在完成后补入。
