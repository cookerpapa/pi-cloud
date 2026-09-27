# Indexed native log：实现与验收

日期：2026-09-27。研究基线：`4ee30caf`。决定：[ADR-0197](../adr/0197-indexed-native-session-log.md)。
状态：实现、离线验证、匹配部署和真实 Luna 验收均完成。
运行代码提交：`83a84cfdeb24de54d768135d8686e8f7b22a3a78`。

## 实现

`pi_session_log` 保存唯一的完整 Entry/Record 正文。稳定检索字段由日志生成，并建立
租户/Session/ID、序号、类型、父节点、Lane/operation、Turn 的索引。删除独立的
Entry/Record 表、COW 引用表和旧视图，迁移全部产品查询和验收脚本；没有兼容视图或
双写。研究比较程序已从当前树删除，其具名基线保存在 `4ee30caf`。

Lane 头、名称、标签和未完成操作是可重建的当前状态。操作状态只引用开始记录的
Session 内序号；同一条日志 INSERT 的触发器先保存 starts，再按每条 finish 的唯一
身份定位并删除对应引用。事务失败一起回滚，批次物理顺序不决定结果，异常多开仍可
被原生恢复检查发现。普通消息批次直接跳过这项状态维护。

不可变 `payload.turnId` 与可置空的控制面关联 `turn_id` 分开。后者保留删除 Turn 时
置空的 FK，且非空时必须匹配原始绑定。重建不恢复已删除关联。迁移也区分两种 Fork：
产品 Fork 保留原 Turn 归属；SDK Fork 原本明确为 null 时，不从旧 COW 源误补绑定。

Fork 直接读取目标日志里的完整副本。原生源 Session 删除不影响 Fork 或嵌套 Fork；
图片由各 Session 的日志独立保留，最后一个引用删除后才可回收。产品子树归档/prune
规则继续适用。Canonical Turn 查询保留执行 Session 归属过滤，避免把 Fork 副本算成
同一轮的重复输出。分支读取先按父 ID 找元数据，再读取选中的正文。

迁移 153 在一个事务内建立新布局并删除旧表，拒绝未封口 Session；既有原生日志正文
无需重写或清空。Pi 接口、Kafka ACK、单 writer/fence、封口及未知 Tool 效果合同沿用
现有架构。当前状态重建不会调用模型或执行工具。

## 离线验证

[逐文件记录与源码摘要](indexed-native-log-verification-20260927.json)：209 个文件，
去重汇总 **1,343 通过、3 项按配置跳过**，含 40 个验收辅助测试。全工作区类型检查、
构建、格式、文档、运行策略、镜像闭包/上下文和依赖硬化检查通过。
[故障矩阵](indexed-native-log-faults-20260927.json)为 **74/74**。

其中包括 Pi 官方 29 项后端契约、真实 PostgreSQL 的投影并发/幂等、迁移回滚和存储
生命周期测试。2,000/20,000 条主分支记录下，custom/generic prepared plan 均保持
40 条分页和 65 个压缩边界节点；空闲 Lane 不读取历次操作正文。

不是一次完整绿色的 `npm run check`：首次整套检查暴露新触发器的大批 Record 联接
耗时异常，改成按结束记录唯一键定位后，同一长历史用例约 8 秒通过，预算仍为 60 秒。
后续整套的失败是两处既有入队/接管 SQL 计数漏算，以及 SSH 测试过早结束模拟进程的
竞态。计数现明确包含已有的 64 条待处理输入检查和锁后的输入快照；SSH 夹具等待命令
到达再结束。最终两个受影响文件完整复测 **40/40、4/4**，其结果替换此前失败文件，
未重复累计。运行时租约、输入保护和超时没有为通过测试而放宽。

## 部署与真实验收

[部署记录](indexed-native-log-rollout-20260927.json)确认 Control Plane、两台 Worker、
Broker、Web 均运行 `83a84cfd` 且健康，12 项关键源码摘要匹配；bootstrap 容器也已用
该版本重建。停旧应用后保存私有 PG 备份，再应用迁移 153；PG/Kafka/S3/Cube 数据服务
保持运行。825 条既有日志切换前后的完整内容摘要一致，9 个既有图片对象和 9 个引用
一致。旧表和旧视图均不存在。Guest 身份仍为
`dbcdd74b623a27ffbdf266c706e2e09331c0532c`，复用既有匹配模板。

最终通过的真实验收使用 GPT-6 Luna，共 **10 个 Run**：

- [原生文件工具](indexed-native-log-tools-20260927.json)：三轮真实 write/read/edit/bash，
  包含 1.5 MB 命令输出的有界尾部、`/tmp` 路径和符号链接。
- [共享 Session 与 Fork](indexed-native-log-live-20260927.json)：Parent 和 Child 都完成，
  共享物理 Session；公共 Fork API 不重复原 Turn 输出，新 Fork 从日志读取压缩摘要和
  原 Workspace 文件。这里通过受测 SessionStorage 写入一个明确的 Compaction 夹具，
  验证真实模型的冷上下文读取；不是 900,000-token 自动阈值或模型生成摘要的性能试验。
- [图片与 Worker 替换](indexed-native-log-images-20260927.json)：两张约 6.3 MB 的图和
  一张 **25,128,725 字节**原图，PG 对应记录分别为 778/778/779 字节。路径被覆盖后旧
  对象仍可读取；切换 Worker 后，Luna 在不调用工具的情况下正确给出三张图的颜色高度
  排序。独立文件核对预期值，另从 canonical Tool intent 核对三段生成命令完全一致。

初版[数字图诊断夹具](indexed-native-log-images-declined-20260927.json)的四个 Run 都已
结束，但最后的识图断言失败：提供商把噪声底图上的四位数字识别为验证码并拒绝提取。
它不计作通过的视觉验收。改用自生成的普通柱状图后，保留相同的大图、覆盖、内容校验
及跨 Worker 条件，最终通过。没有修改模型策略、窗口或阈值。专项脚本也修正了误把
租户默认模型当作本次明确选择模型的检查，以及一处 JS 文件中的类型标注；变更仅在
验收代码，实际部署源码不变。

[清理记录](indexed-native-log-cleanup-20260927.json)：四个测试 Workspace 的字节存储
均已 purge，临时 PostgreSQL 已删除；全局未完成 Run、当前 owner、未封口 Session 和
未结束原生操作均为零。归档的验收历史及其图片引用按既有合同保留。所有应用恢复健康，
没有保留兼容读写路径，也没有宣称多机 HA 或任意工具效果 exactly-once。
