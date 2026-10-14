# 空闲 Worker 重连实施与验收

2026-10-14。[ADR-0248](../adr/0248-idle-worker-management-reconnect.md)的 A1–A4。
状态：已完成并配套上线，目标故障验收和完整生产验收通过。
最终源码 `5b6ba0039665e7f4741e475c0ec51392b6dc0fb4`，运行版本
`worker-reconnect-5b6ba003` / schema 189 / execution-topic v16 / boot reply v3。
初次重连版本为 `c744cfa7`；最终补丁加入下述验收发现的回执读取修复和构建源调整。

## 行为和代码边界

- schema 189 为现有管理连接增加 `expired`，不增加表或执行租约。
- 注册、重复注册、心跳失败和清扫共用超时判断。有效的空闲 Boot 保留；有新鲜
  PG 执行租约的忙碌 Boot 同样保留，但旧管理连接明确结束，不再被延长期限。
- 原进程重新认证、登记并取得新 connectionId。迟到的旧连接消息不能改写新连接。
  真正失效的启动身份及过期未关闭执行权仍按原隔离/封口流程处理。
- Boot 发放和管理登记复用 Host 行锁；取得 Worker、连接锁后再次检查当前授权。
  覆盖旧握手已经通过、随后新 Boot 撤销旧凭据，以及凭据在等待行锁期间过期。
- 领取最终 SQL 内加入当前管理连接条件，保留既有 SQL 往返数。等待期间连接
  失效则整笔回滚，Run 保持 queued，尚未提交的 Session 租约和 epoch 一起回滚。
  原有 Session 续租不依赖管理连接，模型/日志/工具热路径未增加 PG 检查。
- 过期连接退出 active 扫描；Boot 身份记录保留并不表示可领取新工作。
  没有改变 Cube 生命周期、物理清理证明或任意 Shell 的重放语义。

## 专项验证

新增 PostgreSQL 12 项测试通过：四种超时入口、同连接登记幂等/跨传输防重放、
等待连接行锁后的凭据有效期检查、撤销/到期/failed 身份拒绝、新旧 Boot 登记的
真实锁等待，以及新鲜/过期未释放 Session 的区分。

真实 WebSocket 验证原 Boot 自动重连，保留既有迟到 ACK 和跨副本旧连接拒绝测试。
领取测试覆盖领取前过期、创建租约后过期、清扫等待在途领取回滚；原有 PG 并发
领取、SQL 往返预算、时钟、独立 Session 过期和结算测试继续通过。

测试夹具现在显式创建 Boot 授权和登记记录；没有为没有登记的测试 Worker 增加
生产绕过分支。第一轮失败来自夹具 URL 缺少末尾 `/`、手写心跳缺少容量字段和
锁等待链统计过于直接，已分别修正。新增锁后有效期测试也通过。

完全停机脚本已加强：同时检查所有空闲/忙碌 Worker 的 Pod、容器、重启次数、
Boot 和新 connectionId，并拒绝健康 Boot 出现退役记录。保留原 Run/租约/VM、
Kafka 缓冲、两次 Bash 各执行一次、同幂等键新请求及物理清理的原有验证。

## 仓库与发布检查

CI 的依赖、格式、文档、安装、运行策略、Cube 契约、Helm、观测、镜像闭包、
构建、类型与各组件测试均完成。初跑有两条旧断言失败：领取 SQL 开头变化，
迁移数量从 188 变为 189。修正后两项分别在实际 PG/PGlite 中复验通过，未为
通过断言修改运行行为；其他已通过测试没有反复重跑。

随后完成验收脚本 71 项、真实 Kafka 传输 8 项、故障评估 244/244 项和安全审计。
故障评估记录源码为初次版本 c744cfa7，工作树干净。最终回执补丁另通过 95 项相关
真实 PG/传输测试、控制面类型检查、格式/文档和脚本检查。原先按条件跳过的测试没有算作通过。

最终候选 11 个镜像的扫描、匹配预检和维护的 apply 流程通过。切换前 PG 未完成
Run、writer、VM、开发机、终端均为零；发布过程另行检查全节点原生 VM 清单和
writer 排空。切换后控制面 1 个副本、Worker 2 个副本就绪。
7 张账户/凭据/模型配置表的行数及内容摘要与切换前一致；只保存摘要用于比较，
没有导出凭据值或另建业务备份。

构建期间 CLIProxyAPI 镜像下载 Debian 固定安全更新包曾通过本机代理返回 502。
重试后的构建与扫描通过，未跳过更新、检查或替换依赖版本。
阿里云镜像源的同包下载实测约 0.7 秒，仓库 Volume Gateway 已使用该源；
最终补丁已将安全更新脚本对齐到该现有镜像源，保留 Debian 签名校验和固定包版本。
该次构建用约 25 秒取得 9.4 MB 包索引，完整构建、11 镜像扫描和匹配发布通过。

## 线上故障验收

所有模型场景使用 GPT-6 Luna。

| 场景/版本 | 故障/恢复观测 | 结果 |
| --- | --- | --- |
| 60 秒完全停机 / c744cfa7 | 实际不可达 63.977 秒；恢复副本到就绪 12.957 秒 | 原 Run/租约/VM 保持，两次 Bash 各执行一次；空闲和忙碌 Worker 容器/Boot 都保持，新 connectionId；清理通过 |
| 90 秒完全停机 / c744cfa7 | 实际不可达 93.953 秒；恢复副本到就绪 10.299 秒 | 同样保持两个原 Worker、Run/租约/VM，新请求重试只创建一个 Run；清理通过 |
| 实际控制面 SIGKILL / c744cfa7 | 容器退出码 137；恢复 17.306 秒 | 原工具执行一次并完成，两个 Worker 容器与重启次数均不变；物理清理通过 |
| 最终补丁 60 秒停机 / 5b6ba003 | 实际不可达 63.995 秒；恢复副本到就绪 9.515 秒 | 两个原 Worker/Boot、原 Run/租约/VM 保持，新连接生效；执行标记及新请求幂等检查通过，清理通过 |

60/90 秒是主动施加的故障窗口，恢复时间是本机的单次观测，不是升级可用性承诺。
HTTP 新请求的重试由验收客户端执行，不表示所有浏览器 POST 都已自动重试。

真实浏览器验收已通过：丢失输入确认、Stop、返回草稿及图片、同一上传重新发送和
直接识图，以及 ASCII/Unicode 大 Read 源端裁剪和规范诊断；资源清理通过。

两次完整 Cube 尝试和前两次原生输入尝试在不同模型请求遭遇上游
`chatgpt.com` TLS handshake EOF；失败证据与清理结果均保留，未更改模型重试、
代理路由或 fencing 策略。原生输入诊断运行已通过消费、Stop 和真实 Worker
SIGKILL 恢复，随后流式观察场景未完成；不将分次通过说成整个脚本一次通过。

另两次原生输入的同键重试出现 HTTP 500，与 TLS 分开调查。真实 PostgreSQL
交错测试复现 `Document … is missing a required base`：准入事务在 READ COMMITTED
下先读旧 native head，Worker 再更新 latest-only 文档，后续基底查询读不到旧版本。
确认回执并不需要重建 Inbox；改用现有单条当前元数据查询后，该回归和相关 95 项
测试通过，保持原有 fingerprint/acceptedAt 校验和未投影时的 Worker 幂等确认。
补丁已配套发布。最终原生输入脚本一次完整通过五项场景：consume、stop、recover、
stream_stop、stream_both_crash，包含实际 Worker 和控制面进程丢失及同 Run 恢复。
完整 Cube 脚本一次通过纯聊天无 VM、编码、预览、跨 Run 后台进程、千文件工作区
和新 VM 挂载原 Volume。最终浏览器验收及上述补丁停机检查均通过。

最终补丁验收也保留了两次浏览器 TLS 中断，以及一次在故障注入前就结束的停机
准备 Run。后续限次、隔离重跑没有修改测试断言；第一次重跑即完成浏览器和停机
两项。失败尝试没有计作通过，也没有对任意生产 Tool 追加重试。

## 最终清理与保留

全部成功和失败 fixture 的会话、Volume/VM 生命周期先通过既有产品路径收尾。
完整 Cube 驱动留下的三个本次临时租户，经精确 ID/slug 核对并通过现有
`purgeOwnedAcceptanceTenant` 的物理清理/未完成控制检查后删除；未扩大到历史
租户或原用户账户。最终七张账户/凭据/模型配置表的数量和摘要与最初基线一致。

最终 PG 未完成 Run、未释放 writer、活动 VM/开发机/终端、待清理 Workspace 均为
零；原生 Cube 清单扫描 1/1 个节点，物理 VM 为零。控制面 1/1、Worker 2/2、Web
1/1 均就绪，镜像均为 `worker-reconnect-5b6ba003`。

私有证据为 `/tmp/pi-cloud-reconnect-{outage60,outage90,process}.json`、
`/tmp/pi-cloud-reconnect-process-workers.json`、`/tmp/pi-cloud-reconnect-faults.json`，
最终补丁的 `/tmp/pi-cloud-reconnect-patch-{native-input,production}.json`、
`/tmp/pi-cloud-reconnect-final-{browser,outage}-1.json`、
`/tmp/pi-cloud-reconnect-final-state.json`、
`/tmp/pi-cloud-reconnect-production-fixture-cleanup.json`，以及
`/tmp/pi-cloud-release-worker-reconnect-5b6ba003/` 的最终匹配发布证据。
原始模型文本、用户仓库和凭据不进入 Git。

ADR 中列出的 dispatch 接单窗口、存活 peer 地址缓存、workflow/终端/预览交接
及单独控制面发布入口，仍是后续切片，不由本次重连修复宣称完成。
原有 Boot 登记凭据默认 24 小时有效、没有自动续期；过期仍拒绝重连。长寿命
Worker 的凭据续期应在后续控制面单独发布切片中评估，本次没有悄悄延长或复活授权。
