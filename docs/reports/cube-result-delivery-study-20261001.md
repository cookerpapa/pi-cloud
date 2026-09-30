# Cube 接管执行与结果投递：可行性研究

日期：2026-10-01。研究结论，不是已部署的执行协议。
承接 [September 30 review](repository-review-20260930.md) 的 D30-01 及后续讨论。

## 结论

让 Cube 的可信执行侧接管命令、独立把完成结果送入 Kafka，能够减少工具执行对 Broker
进程和长连接的依赖。应以“Broker 重启后，已经接管的工作仍能完成并交付结果”衡量收益，
而不是以代码中是否出现 `await` 衡量可靠性。

本次核对的 Cube、E2B/envd 和 OpenSandbox 都有可借鉴的执行原语，但没有找到能直接满足
PiCloud 整份合同的现成宿主侧 Kafka 结果投递接口。升级 SDK 或开启后台执行不能自动实现
这项能力。当前保留现有链路；建议把后续工作限定为 Cube 原生能力的接口设计和隔离原型，
不在本轮引入另一个任务引擎、PG Tool operation ledger 或 guest Kafka 客户端。

## 范围与来源

| 实现 | 核对版本 | 能采用/借鉴的部分 | 与目标之间的缺口 |
| --- | --- | --- | --- |
| CubeSandbox | PiCloud 固定 v0.6.0；官方最新发布 v0.7.2，另核对 September 30 HEAD | KVM、现有 envd/vsock 执行与平台生命周期 | 当前命令接口仍将执行流交回调用方，没有接管任意 Tool 后向 Kafka 可靠交付的现成合同 |
| E2B envd | 最新发布 2026.30 与 September 30 HEAD | 与请求连接分离的进程生命周期、运行中重连、退出事件短暂保留、live-upgrade handover | 保留退出码不等于保留遗漏的完整结果；这些状态在 guest envd 内，不能直接充当 PiCloud 的可信宿主侧发布权威 |
| OpenSandbox execd | release-1.1.0 发布信息、September 30 main 源码 | 后台命令、执行状态和输出读取接口 | 状态依赖执行器内存及其输出文件，接口是 SSE/查询；没有本次所需的宿主侧 Kafka 交付和 PiCloud fencing 合同 |

Cube、E2B infra、OpenSandbox 根许可证均声明 Apache-2.0；Cube 另列第三方组件声明。
本轮没有复制其实现到 PiCloud，也没有安装替代运行时。
维护活动与版本来自官方 [Cube releases](https://github.com/TencentCloud/CubeSandbox/releases/tag/v0.7.2)、
[E2B release](https://github.com/e2b-dev/infra/releases/tag/2026.30)、
[OpenSandbox release](https://github.com/opensandbox-group/OpenSandbox/releases/tag/release-1.1.0)。
具体 revision、源码文件及哈希见 [研究清单](cube-result-delivery-study-20261001.json)。

### Cube：现有结果仍沿执行连接返回

v0.7.2 的 Node `commands.run` 向 envd 的 `process.Process/Start` 发起请求，收集输出和
EndEvent；CubeProxy 的对应配置负责转发这条流。September 30 HEAD 中核对的接口仍是
这一路径。回调文档里的鉴权 callback、SDK 输出 callback 不能解释成平台完成事件投递。
见 [命令实现](https://github.com/TencentCloud/CubeSandbox/blob/f1aaa737fb3862202b1731e0e0d844c28779f930/sdk/node/src/commands.ts)
和 [流转发配置](https://github.com/TencentCloud/CubeSandbox/blob/f1aaa737fb3862202b1731e0e0d844c28779f930/CubeProxy/conf/includes/envd_streaming_host_route.inc)。

PiCloud 的 Node 工具执行器已经收到 operationId，也已经输出完整工具返回值。缺的是
沙箱外执行侧独立拥有接管、完成捕获和交付状态；增加一个 ID 不能替代这份合同。

### E2B：退出码可恢复，完整输出仍有缺口

当前 envd 将进程上下文与 HTTP 请求上下文分离，连接中断不直接等于终止命令。
与旧 2026.16 源码相比，2026.30 增加了约 30 秒的终态保留和升级交接处理。
源码明确只保留终止事件；没有为此重放断连期间遗漏的完整输出。因此不能凭成功读取
exitCode=0 就构造一个完整的 Pi Tool Result。
见 [Start](https://github.com/e2b-dev/infra/blob/2026.30/packages/envd/internal/services/process/start.go)
和 [终态保留实现](https://github.com/e2b-dev/infra/blob/2026.30/packages/envd/internal/services/process/service.go)。

### OpenSandbox：后台命令也是一份需要管理的执行状态

所查源码从 commandClientMap 读取运行状态，后台输出通过对应文件读取；SSE 完成回调
负责结束当前响应。这提供了后台执行和结果读取的参考，但不能据此推断执行器/节点重启后
结果一定存在，更不能直接赋予 guest 向 PiCloud 私有 Kafka 发布消息的权限。
见 [状态与后台输出](https://github.com/opensandbox-group/OpenSandbox/blob/0b6acd5fd66fa885b875ad80674c69827343c26b/components/execd/pkg/runtime/command_status.go)
及 [命令控制器](https://github.com/opensandbox-group/OpenSandbox/blob/0b6acd5fd66fa885b875ad80674c69827343c26b/components/execd/pkg/web/controller/command.go)。

## 候选责任划分

保留已确认的请求路径：

```text
Worker → Kafka execution log → Projector → Broker → Cube
```

未来可研究在 Cube 明确接管后采用：

```text
guest Node → Cube 可信执行侧 → PiCloud 结果适配 → Kafka reply → 原 Worker
```

“结果适配”是职责边界，不是在这里决定增加一个服务。它负责沿用已有 PiCloud reply
schema、大小限制和图片 claim check。Cube 核心无需理解 Agent Loop；Pi after-tool hooks
和 canonical Tool Result 仍在 Worker 中。Kafka/S3/平台凭据保持在 guest 之外。

1. Broker 继续检查 PG Run/Session lease、Tool policy 和 fencing。Cube 的接管确认明确
   operationId、实际执行实例、请求身份及后续结果交付的责任。不能只把 HTTP 接收称为接管。
2. 可信侧保存调用与回复目的地的关联，guest 返回的 ID 只用于核对，不能任意选择别人的
   Worker Topic、租户或附件归属。复用同一 operationId 的不同请求必须拒绝。
3. 对同一份结果可重试投递，并以 operationId 在接收侧去重；不得因结果发布失败重跑命令。
   结果发布成功后释放临时状态，不另建 completed-result GET/cache。
4. 最小原型只承诺 Broker 重启独立性。若进一步承诺执行侧进程/节点重启后还能补发，必须
   额外证明待交付结果的持久性；不能用内存 Map、退出码缓存或 Workspace 文件冒充这项保证。
5. Node/VM 崩溃与整个执行节点失联分别处理。可信执行侧活着时可报告已经观察到的故障；
   整个节点失联仍需要外部期限和失联判定，并保留 UNKNOWN 效果语义。

## 不能遗漏的现有耦合

- **Broker boot 与生命周期。** 当前 binding 属于 Broker boot，旧 binding 不会被新 boot
  接管；重启后的 orphan 清理可能回收 VM。只改结果回程、保留这套回收行为，不能证明
  Broker 重启不影响任务。执行接管和 VM 清理必须一起定义。
- **Run 取消与 Writer seal。** 已关闭的调用不能被迟到回复重新打开；新 Worker 不接续旧
  boot 的 Promise。Cube 的完成交付不得延长或自行签发 PG 执行权。
- **工具失败与 VM 失效。** 命令退出、单次连接断开、确认 VM 丢失应分开。宿主側进程终止
  证据也不代表已经发出的外部请求被撤销。D30-01 不能靠无条件删掉 destroy 分支解决。
- **图片。** 正常返回若含图片，必须完成已有不可变对象存储流程，再发引用；不能重新把
  大图塞进 Kafka，也不能让 guest 持有平台 S3 凭据。
- **workflow.exec。** 它还通过 Broker 的双向通道发起 `runs.*` 调用。单独迁移最终结果
  不会使运行中的 workflow 跨 Broker 重启。第一阶段应限定固定 read/write/edit/bash，
  明确 workflow 的限制，不能宣称全部 Tool 都已解耦。

## 必须通过的故障实验

| 注入位置 | 应证明的行为 |
| --- | --- |
| Cube 接管前 Broker 停止 | 已提交日志保留事实；不因为重放日志自动执行旧命令 |
| Cube 接管确认丢失 | 不重复启动命令；可确认既有接管或明确 UNKNOWN |
| 接管后 Broker 停止 | 原 Run 仍有效时，工具和结果交付不依赖旧 Broker 连接 |
| Node 完成后、Kafka 发布前 | 仍能交付完整结果，或在超出原型保证时明确失败，不能捏造成功 |
| Kafka 已收结果但 ACK 丢失 | 允许重复结果投递，Worker 只完成一次回调，命令不重跑 |
| 取消/seal 与完成并发 | 迟到结果不能改变封口后的历史或继续调用模型 |
| 单个 guest VM 丢失 | 同 VM 使用者获得环境丢失事实；其他 VM 的有效任务不受影响 |
| 整个执行节点丢失 | 有界失联处理；不声称任意 shell 效果 exactly-once |
| Worker boot 被替换 | 回复不能交给另一 boot 冒充旧调用的恢复结果 |

## Build versus adopt 与后续建议

先争取 Cube 原生的可信执行接管与通用结果 sink 扩展，再通过 PiCloud-owned adapter 接入
已有 Kafka reply/附件端口。E2B/OpenSandbox 的后台 API 是参考，不能作为静默替换 Cube
或把 guest 执行器提升为发布权威的理由。通用任务引擎会引入另一套任务历史和恢复语义，
目前没有证据证明它比现有有限执行适配更合适。

本轮保留当前实现，没有创建常驻宿主代理、持久 Tool ledger 或结果查询缓存，也没有给
Cube guest 开 Kafka 网络。后续若做原型，应先记录接管/取消/回收协议 ADR，在独立测试
环境完成上述实验，再讨论生产切换；不能仅凭 SDK 返回了一个进程 ID 就声称可靠接管完成。
