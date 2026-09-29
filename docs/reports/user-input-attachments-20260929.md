# 聊天附件与原生视觉输入验收

日期：2026-09-29。决定：[ADR-0200](../adr/0200-workspace-uploads-and-user-image-input.md)。
运行版本：`1341b73cf98f6d92e52874704556442a62524bff`。
接口、限额与失败语义：[聊天附件合同](../CHAT_ATTACHMENTS.md)。

## 行为与边界

聊天框支持选择文件、拖放和粘贴图片。文件先落入当前 Workspace 的独立上传目录；
普通文件只附带名称、路径和大小，图片另外保存不可变的 Session 副本。
发送时，Harness 组装原生 Pi 用户文本及 ImageContent。模型的第一次请求直接含图，
不需要先发起一次 read 调用。

图片解码与缩放仍在 Cube 内完成。Broker 使用当前 Run 的授权、激活和取消机制；
准备图片不占模型 permit，也不伪造 Tool 事件。Kafka、PG 输入命令和原生日志均只
保存有界元数据或图片引用。Pi 0.84.1 Agent Loop、Session writer、Projector 和
Tool 的 commit-before-dispatch 合同保持不变。

普通文字输入仍为接受 **6 次**、Worker admission **9 次**客户端 SQL；附件字段
与文字在同一 admission 查询中读取。上传自己的授权、字节落盘、S3 和元数据确认
发生在上传路径，不增加每个模型 Step 的查询。

图片源文件即使被修改或删除，已接受消息仍能恢复原图。队列编辑、排序、取消、
转 steer 保留附件身份；取消消息不会删除 Workspace 文件。未接受草稿 24 小时
后释放图片引用，已接受附件按 Session 生命周期保留。

并发、取消与失败验证包括：16 MiB 单文件/32 MiB 合计上限、HTTP 预缓冲限流、
租户/Session/Workspace 归属、重复上传和丢失响应、符号链接拒绝、清理与图片
引用确认竞态、图片准备失败前不占模型 permit。临近结束的图片 steer 会被取消
并等待其激活请求完成，再释放 Cube；正常释放也等待访客端图片处理退出。

## 真实 Luna 与浏览器

[主体记录](user-input-attachments-live-20260929.json) 使用新建临时租户和 Workspace：

1. 浏览器上传 **1,851,298 字节** PNG，真实 Caddy 的 CSP 下预览正常。
   GPT-6 Luna 首次直接识别图中的随机六位数字，**0 次 Tool 调用**。
2. 刷新页面后，原始用户文字和附件卡片分别恢复，图片预览可用。
3. 上传普通文本文件，Luna 用 read 读取后用 bash 改写 Workspace 中的图片文件。
   会话图片 API 返回的源字节校验值仍与上传时一致。
4. 停止最近的 Worker，另一个 Worker 冷读原生日志及附件。Luna 无 Tool 调用，
   正确回答原图中此前未要求回答的柱高顺序；原图不依赖已经改写的路径。

包含图片引用的原生日志最大记录 **1,956 字节**；图片字节没有进入 Kafka/PG 日志。

[队列转 steer 记录](user-input-attachments-queue-live-20260929.json) 独立验证：
在一个真实 bash 等待期间，接受无文字的图片消息，编辑其文字，再提升为 steer。
Luna 直接识别新图，目标 Run 只有原来那次 bash 调用，没有读图调用；canonical
history 恰好有一条带图片的该控制输入，原 queued Run 取消且未另行执行。

合计四个完成的模型 Run、三个成功的普通 Tool 调用，以及一个被 steer 消费后
取消的 queued Run。两个场景分别保留执行时脚本摘要；后一次增加独立的 queue
场景，主体场景没有更改其验收逻辑。

## 自动校验与部署

[故障矩阵](user-input-attachments-faults-20260929.json) **90/90**。它保留启动时的
HEAD 和 dirty 标志；后补的临近结束准备清理，另通过 Runner/Broker 67 项回归及
受影响工作区类型检查。原生 user image 的 PG 冷读、嵌套 Fork、源 Session 删除、
重建和清理通过；既有 codec Compaction 与 Pi backend conformance 合同继续运行。

全仓 `npm run check`：**1,413 项通过、3 项 opt-in 跳过、0 失败**，包括 Pi backend
conformance；工作区构建、浏览器、真实 Caddy、镜像闭包/上下文、运行预算及监控
检查通过。命令、计数和源码摘要见
[验证记录](user-input-attachments-verification-20260929.json)。第一次完整检查发现
旧测试仍假设纯文本输入、旧查询列名，且使用当前 admission API 构造迁移前数据。
现已改为独立旧 schema fixture，并更新有意改变的协议断言，没有加入运行时兼容代码。

[部署记录](user-input-attachments-rollout-20260929.json)：迁移 154 前停止应用并保存
私有 PG 备份，再启动配套 API、Worker、Broker、Volume Gateway、Web 和新 Guest。
部署前后 **1,370 条原生日志**校验值相同，已有 **15 个图片对象**及其总字节数相同。
所有应用健康；两个验收 Workspace 的存储已清除，测试凭据已撤销，未完成 Run、
活跃 owner、未投影 seal 和未完成原生 operation 均为零。

Cube 模板登记成功；其既有旧模板保留任务有 15 项因节点清理超时而延后，记录中
如实保留，没有绕过保护或声称全部旧模板已清除。这不影响本次 READY 模板与运行。

此切片没有实现一般文件永久归档、图片生成、Agent Team 或本地/云端 Agent 交接。
接受的图像格式为 PNG/JPEG/WebP，每条最多四个文件；不宣称任意文件格式理解。
