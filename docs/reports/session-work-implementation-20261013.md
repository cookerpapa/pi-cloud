# Session 工作与工具通道改造记录

状态：6ba81a94 已匹配部署；子 Agent 滚动替换修复正在验收，尚未完成本项。业主已授权实施
[ADR-0247](../adr/0247-session-work-and-tool-dispatch.md) 并在验收后按维护流程上线。
基线 f5c0d9d8。运行逻辑提交 4f887b17，镜像入口检查修复后以 3491d44e 部署。
11 个产物扫描通过，schema 188 / topic v16 / reply v3 已上线；原 9 类账户/配置/
凭据表摘要一致。旧 v15 Topic 已删除，旧 v2 Topic 随旧 Worker 退出删除。

## 已接通的源代码

- 同一物理 Session 只领取一份根工作。原生 Harness 管理所有子 Conversation，
  子对话有独立配置、输入/取消和展示位置，不创建子 Run、不单独封口。
- Worker 只保留工具定义和通用代理。控制工具引用随原生意图一次提交；Projector
  重建控制引用，控制面通过 Worker 原生管理端口处理。Cube/控制工具共用 v3
  Kafka mailbox，Pi 处理回包后保存正式结果。
- 工具绑定按环境申请区分。Cube 的 executionScopeId 使用 binding ID；共享根
  Run 的一个绑定关闭不会停止兄弟绑定。workflow 同批操作和单绑定关闭已有测试。
- 正常 work_finished 由 Worker 提交，Projector 更新根工作及正常 owner 退役；
  已请求强制封口时，必须继续等该封口，迟到恢复记录不重排已完成的工作。
- Worker 已直接使用稳定物理 Session Kafka 事务 ID，初始化前后各查一次 PG；
  普通提交没有 PG/控制面 HTTP 跳转。旧 Worker open/append 入口与身份缓存已删除。
  控制面保留控制引用和 Session 封口；后者同时接受 Kafka 消费组成员隔离。
- schema 188 删除旧子命令/子 Run 依赖及 unsealed_runs/native_output_drained。
  子任务索引没有状态/正文副本；状态从原生 Task/Submission 派生。源正文保留 text，
  避免 PG jsonb 拒绝原生 JSON 中合法的 NUL/孤立代理项。

## 已取得的验证证据

- 最新源码专项 4 文件/64 项通过，覆盖真实 Harness/PG 的父子执行、输入去重、
  单子失败传播、正常完成/强制封口竞态。子历史 fork 与父级删除规则另有通过证据。
- 完整 RF3/PG 传输套件 6 文件/7 项通过，已包含：控制面退出期间继续发布、
  重启补投影、同 Run 换 writer、旧封口重放；延迟旧初始化挤掉新 writer 后拒绝
  旧授权，再封口并用第 3 代恢复；超大记录拒绝不毒化 producer；控制工具引用重建。
- 既有 Worker 心跳循环检查本地 producer 失败，在模型没有新提交时也触发恢复；
  不增加 PG 心跳或把沙箱探针缺失当作销毁依据。专项 2 项通过。
- 全仓类型检查的新增测试类型问题已修复，相关包重检通过。构建、格式、文档、
  安装合同、运行时策略、原生 Cube admission/allocation、Helm、可观测性与镜像
  闭包检查通过。资产恢复/构建输入等 helper 共 64 项通过。
- 最新整仓回归通过，所有 Workspace 测试命令退出码为 0。控制面 341、核心运行时
  74、Sandbox control 282、Pi 运行层 181、Worker 86、前端 174 项通过；隔离的
  Kafka/PG transport 套件覆盖默认跳过的传输场景。当前封口格式测试已更新。
- 更新后的故障清单 244/244 通过，HIGH 级依赖安全审计通过。
- [同负载初测](session-work-transport-20261014.md)记录了直写 ACK 延迟和 native
  producer 的额外线程/FD/RSS；测量时有并行单测，不作为生产 SLO。
- 2026-10-14 上线前只读盘点：schema 187；会话、Run、租约、native commit、
  Tool binding、未清理 Workspace 均为 0；Cube 全节点扫描 1/1、VM 数量 0。
  9 类账户/配置/凭据表已记录不含明文的校验摘要，供部署后比较。

## 尚待完成

1. 提交已验证源码并准备完整匹配产物。
2. 收尾验收证据和维护文档；回包长等待使用虚拟时钟，真实 Kafka 回包另有合同测试。
3. 固定 schema 188/topic v16/reply v3 的匹配发布，提交源代码并构建扫描。
4. 排空写入、确认物理资源清理后移除废弃开发数据；保留账户、模型配置和凭据。
5. 部署完整匹配版本，并用 GPT-6 Luna/Cube 做真实功能、恢复和兼容控制面替换验收。

首个匹配版本已部署；滚动修复和最后验收完成前，不标记本项完成。

## 真实验收进展

- Luna/Cube 完整验收通过：纯聊天不建 VM、工具、预览、Warm 复用、后台服务、
  大 Workspace 换 VM 恢复、租户隔离、资源清理。旧验收脚本要求终态 Outbox 的
  断言已改为检查 work_finished 的投影及没有强制 seal，运行实现未改动。
- 原生子对话 5 场景通过：监督问答、消息、并行、取消、guest workflow 边界。
- 原生输入/流式中断 5 场景通过，包括真实 Worker SIGKILL 与 Worker/Projector
  同时丢失内存；同 Run 恢复、草稿编辑和未消费输入返回、原生 partial 保留通过。
- 真实滚动替换暴露分区暂停状态残留：结果都在 Kafka，PG 停在旧位置。单实例
  重启使已完成工作收尾；隔离 RF3 已复现失败并验证 resume 新 assignment 的修复。
  必须发布该修复并重跑真实滚动验收。图片/browser 最终验收仍待完成。

6ba81a94 已修复分区 pause 遗留，真实 Bash 滚动验收通过：交接 12.467 秒、
同一 Worker、单次物理执行和清理通过。随后新增的子 Agent 场景暴露另一项：
控制引用恢复后与展开命令重放被误判为身份冲突（ADR-0247 第 15 节）。正在修复，
不能据单一 Bash 场景将整个滚动门槛记为通过。
