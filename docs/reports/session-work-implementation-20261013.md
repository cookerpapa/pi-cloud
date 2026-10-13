# Session 工作与工具通道改造记录

2026-10-14；[ADR-0247](../adr/0247-session-work-and-tool-dispatch.md) 已部署为
`session-work-6ac697f9`，schema 188 / execution-topic v16 / boot reply v3。
源码、传输、真实模型/故障、滚动交接与浏览器验收全部完成。基线 f5c0d9d8；主实现 4f887b17，首次发布
3491d44e，滚动交接修复 6ba81a94、6ac697f9。后续文档提交不代表运行镜像变化。

## 已落地的行为

- 一份云端 Run 表示根工作及其普通派生任务。一个物理 Session 只持有一份
  PG 租约、一个 Worker family 槽位、一个原生 Harness 和一个 writer。
  子 Agent 直接成为 Pi Conversation/Task，不再创建、领取、结算子 Run。
- Worker 保留 Pi、模型端口、工具定义和通用代理。经过 Pi 校验的工具意图及
  派发引用同批提交 Kafka；Projector 派发，控制面处理 subagent/监督/preview，
  Cube 执行完整文件/Shell 工具及不可信 workflow JavaScript。
- Cube 与控制工具共用 Worker boot Kafka 回包。Worker 将准备好的内容交给 Pi，
  Pi 处理后保存正式 Tool Result。没有原始结果 GET 缓存或第二份 PG 工具账本。
- Worker 直接向 Kafka 写入。事务 ID 固定到物理 Session；初始化前后各校验 PG
  授权，普通提交没有控制面 HTTP 跳转或逐次 PG 授权查询。提交不确定时停止原
  writer，经有序关闭及新租约恢复；不自动重试旧批次，也不重放任意 Shell 效果。
- 子任务按原生完成/取消语义结束，不单独封口。根工作等待原生任务族收尾，
  提交 work_finished，由 Projector 更新根 Run 和正常 writer 退役。正常完成
  不再往返终态 Outbox；已发起的强制封口仍须按原顺序完成。
- 资源绑定按环境申请区分，Cube executionScopeId 使用 binding ID。单个子
  绑定关闭不会关闭兄弟绑定。VM 销毁与配额释放继续要求真实物理清理证据。
- 删除旧 Worker open/append HTTP、入口身份缓存、子命令表、子 Run 调度及
  unsealed_runs/native_output_drained。子索引保留来源与展示关联；Task/Submission
  决定状态，参数正文从原生日志读取。原生不透明 JSON 保持 text。

## 自动化和产物验证

| 范围 | 结果与边界 |
| --- | --- |
| 迁移整仓回归 | 263 文件 / 1665 项通过；后续两项交接修复另跑对应回归 |
| PostgreSQL / RF3 Kafka | 最终 7 文件 / 8 项通过，含直写、接管、延迟旧初始化、同 Run 恢复、引用重建、分区交接和有序取消 |
| 引用恢复与重放 | 新增测试修复前复现冲突；修复后控制工具 5 项全部通过，真正改变回包目标仍拒绝 |
| Reader 修复 | 重叠成员交接时遗留暂停状态，隔离测试修复前失败、修复后通过；event-log 单元测试 28 项通过 |
| 其他门槛 | 全仓类型/构建、格式、文档、安装、运行时策略、Cube admission/allocation、Helm、可观测性、镜像闭包通过；helper 64 项、故障清单 244/244 通过 |
| 最终修复检查 | 控制面类型、格式、文档及完整 transport 重检通过；未把局部重检写成第二次完整 1665 项回归 |
| 发布 | 最终 11 个镜像产物通过维护的扫描与一致性门槛，匹配发布成功；运行协议无旧版本兼容路径 |

长回包等待通过虚拟时钟验证 90 分钟，不是实际运行 90 分钟的付费模型试验。

## 真实模型和故障验收

模型调用统一使用 GPT-6 Luna。3491d44e 上完成的功能/故障场景，与最后两次局部
修复的重测分别记录，不将不同修订的证据混写为一次运行：

- 完整 Cube：纯聊天不启动 VM；真实 write/read/bash、预览、warm 复用、后台
  服务跨根 Run 保留；1,024 文件 Workspace 换 VM 后从同一 Volume 恢复；租户
  隔离及物理清理通过。5 次正常 work_finished，不依赖强制终态 Outbox。
- 原生子对话：监督问答、Agent 消息、两个并行子任务、单子取消、guest workflow
  边界共 5 场景通过。没有子 Run，父子属于同一物理 Session。
- 原生输入和恢复：编辑/重试、停止返回草稿、真实 Worker SIGKILL、流式 Stop、
  Worker 与控制面同时 SIGKILL 共 5 场景通过。同一 Run 恢复，已显示 partial
  保留，PG 不积累流式正文或输入的编辑中间版本。
- 真实浏览器图片/Read：丢失提交回执后 Stop、返回图片与文字、以新输入身份
  重发、直接视觉输入通过；120 KB ASCII / 140 KB UTF-8 Read 在数据源裁剪，
  正式结果带有续读诊断。该专项在首次发布与最终版本上分别记录结果。

滚动替换固定 Worker/Pi/Cube/协议，仅替换控制面 Pod：

| 场景 | 版本 | 结果 |
| --- | --- | --- |
| 正在运行的 Bash | 6ba81a94 | 交接 12.467 秒；原 Worker、单次执行、完成投影及清理通过 |
| 子 Agent 执行 Bash，父 Agent 等待 | 6ac697f9 | 交接 13.772 秒；无子 Run、同一 Worker、控制回包恢复、单次执行和清理通过 |
| 图片回答正在流式输出 | 6ac697f9 | 交接 13.833 秒；同 Worker，图片及交接前文本保留，590 次文字更新，最终 27,107 字符，清理通过 |
| 完整浏览器界面及最后图片/Read 重检 | 6ac697f9 | 登录、模型设置、队列/steer、导出、终端、Fork、弹性/专属资源及删除通过；图片返回/重发和两种 Read 裁剪重检通过 |

交接时间包含 Kubernetes Pod 就绪与旧 Pod 退出，不等于用户可见停顿。流式场景
交接前已有 400 字符，新 Pod 就绪时已观察到 2,613 字符；整轮最长文字更新间隔
为 35.368 秒，其中还包含模型生成和文本合并时间，不能当作零停顿或全部归因于
内部交接。最初的重复行图片提示在注入故障前就结束，未计为通过；改用长教程后
才实际覆盖流式输出与重叠替换。以上是相同镜像的重叠 Pod
替换，不证明任意 schema、Worker 或协议变更都能无损滚动。

## 验收暴露的两项修复

1. 3491d44e 的 Kafka Reader 在重新分配后保留原分区的暂停状态。旧 handler
   因 generation 已变化不会恢复它，造成已写 Kafka 的结果迟迟不投影。安装新
   assignment 时显式 resume，再由恢复逻辑暂停确实不可用的分区。已有分区
   offset 与工具派发保护不变。
2. 6ba81a94 的控制工具恢复保存引用，正常消费却保存展开命令。重放同一意图
   被误判为身份冲突。现在两条路径都只保存同一种引用，执行时再从原生记录
   解析参数；身份冲突检查保留。新的子 Agent 实验已证明该场景恢复正常。

第二次失败测试已通过正常停止写入原生收尾；控制面重启后最终完成该取消任务的
积压投影。确认 writer 关闭、文件只有 started/finished 各一次后，经产品 API
删除该测试会话和 Workspace，并确认物理清理。没有跳过 Kafka 记录、删除活跃
归属记录或重新执行 Bash。原计划的临时控制面单独升级被当前状态检查拦下，
未执行；最终仍走完整匹配发布。

## 切换与保留范围

首次切换前，业务会话、Run、租约、原生 commit、VM 和待清理 Workspace 均为 0；
Cube 完整节点扫描为 1/1，VM 为 0。原 9 类账号/模型配置/凭据表在首次切换前后
摘要一致。旧 v15 Topic 已删除，旧 v2 回包 Topic 随旧 Worker 退出删除，清理了
4 个旧模板。后续两次修复没有重置账户、模型、凭据或现行业务 schema。
最终盘点：所有维护服务就绪；未完成 Run、未释放 writer、VM、待物理清理的
Workspace 均为 0；Cube 全节点扫描 1/1、VM 为 0。完整浏览器报告记录的是
已部署 6ac697f9；当时工作区只有验收脚本/文档收尾变动，不代表新运行镜像。

[传输初测](session-work-transport-20261014.md)显示本次直写降低 ACK 等待，同时
16 个活跃 Session 增加 96 个本地线程、219 个 FD、约 13.5 MiB RSS。测量存在
并行测试负载，不能外推生产 SLO 或大规模容量。更大并发、独立物理节点 HA、
全天候 soak、任意 Shell exactly-once 均不在这些验证结论中。

阅读进度继续保留在[检查点](../READING_PROGRESS.md)：下一跳 **Kafka → Projector**。
