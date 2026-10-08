# 沙箱执行与回包：可替换性研究

日期：2026-10-08。PiCloud 基线 `cf0a4c26`。这是官方文档与公开源码研究，
不是第二后端实现、迁移决定或实际故障验收。未修改运行服务、协议、依赖或数据。
[源码清单](sandbox-result-portability-20261008.json) 固定公开 revision 和文件哈希；
main 分支观察与稳定发布版本分开记录，不把 main 的全部能力归给最近的稳定版本。

## 结论

目前替换 Cube 或同时增加其他沙箱，确实不是换配置/SDK 即可完成。
耦合集中在执行接管、目的端 fencing、取消、回包，以及 VM/Volume 生命周期。
Pi Harness、会话日志和模型接入可以保留。Kafka 不要求底层每个沙箱都原生支持 Kafka。

代码已经有可复用边界，但尚未完成多后端抽象：

- [SandboxProvider](../../packages/sandbox-control/src/sandbox-provider.ts) 隔离了部分生命周期操作，
  但有效隔离类型仍明确写为 `cubesandbox-kvm`。
- [ToolCommandDispatcher](../../packages/sandbox-control/src/tool-command-dispatcher.ts)
  直接依赖 `CubeSandboxRuntimeClient.submitTool/cancelTool`，并解释 Cube 的错误分类。
- [执行描述](../../packages/sandbox-control/src/sandbox-execution.ts) 假定 API/node/sandbox/boot
  目标身份；创建关闭、节点缺失判断、持久 Volume 和开发机恢复也有 Cube 特定约定。
- [cube-completion](../../packages/cube-completion/src/adapter.ts) 已把固定 Tool 回包校验、
  图片外置和回复编码封装起来；[入口](../../packages/cube-completion/src/main.ts) 组合 PG 图片
  索引、S3、Kafka 和临时进度 HTTP。它没有导入 Cube SDK，具有抽成通用结果适配器的基础。
  Native 最终结果仍须经过原 Worker 的 Pi Harness 才成为会话中的 canonical Tool Result。

当前固定 Tool 路径：

```text
Worker → Session Kafka → Projector → CubeAPI/Cubelet：短请求接管
                                      ↓
                               guest 固定 Node Tool
                                      ↓
                           可信 completion adapter
                            ├─ 图片 → S3，回包放引用
                            └─ Kafka reply → 原 Worker → Pi → canonical Session log
```

Cubelet 的 Go 扩展有 Driver/Delivery 分工；Kafka 发布在配置的宿主侧 Node adapter 中。
接管后的执行上下文独立于提交 RPC；同一份结果可在有界窗口内重试投递，命令不会因此重跑。
这是 Projector 连接/进程独立性，不是跨 Cubelet/节点崩溃的完整结果持久化保证。
Worker 回复邮箱也明确是 boot-scoped；新 Worker 不恢复旧 Promise。
参见[固定执行补丁](../../deploy/cubesandbox/patches/0003-native-tool-execution.patch)、
[后续修正](../../deploy/cubesandbox/patches/0004-recoverable-vm-allocation.patch)和
[回复邮箱](../../packages/event-log/src/tool-replies.ts)。当前取消语义以 ADR-0229 为准，
不可从早期研究或 ADR-0210 中已被后续决定替代的 Stop 描述反推现状。

## 代表性实现如何返回结果

### 原生 CubeSandbox

官方 Node SDK 的 `commands.run` 请求 envd `process.Process/Start`，收集 DataEvent 的
stdout/stderr 和 EndEvent 的 exitCode。CubeProxy 转发流；缺少 EndEvent 会报错。
这条原生路径和 PiCloud 新增的 CubeAPI→Cubelet 接管/回包路径应分开理解。
核对[命令实现](https://github.com/TencentCloud/CubeSandbox/blob/e02976ae54729fb1684c5b51535381e54df1aea2/sdk/node/src/commands.ts)
及[流代理](https://github.com/TencentCloud/CubeSandbox/blob/e02976ae54729fb1684c5b51535381e54df1aea2/CubeProxy/conf/includes/envd_streaming_host_route.inc)。

### E2B

`commands.run`/`connect` 使用 envd 的 Connect RPC 事件流，给出进程 ID、输出和退出信息。
后台模式允许调用方返回后继续执行；进程超时与连接等待超时要分别处理。
官方[后台命令文档](https://docs.e2b.dev/commands/background)特别建议跨调用方重连时把输出
重定向到文件，再通过文件 API 读取。所查
[envd 源码](https://github.com/e2b-dev/runtime/blob/f62fa7918b0b53c97b26e8eced3f232d0ccd8b00/packages/envd/internal/services/process/service.go)
保留退出事件约 30 秒，没有借此重放整个遗漏输出流。
因此“还能知道 exitCode”不等于“能补出完整 Tool Result”。
当前官方 runtime 仓库由旧 `e2b-dev/infra` 地址重定向到 `e2b-dev/runtime`。

### OpenSandbox

常用 `/command` 接口用 SSE 返回执行事件；后台命令可按 ID 查询状态与增量日志。
[API 规范](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/specs/execd-api.yaml)
给出完成状态/后台输出至少 24 小时的保留与清理策略。
这一路径的[状态查询](https://github.com/opensandbox-group/OpenSandbox/blob/c7dc78a4090e5de2b9119e9bd93952cae24f87bd/components/execd/pkg/runtime/command_status.go)
依赖内存 `commandClientMap`，输出读取临时文件；不能把保留窗口当作节点或 execd 重启后的承诺。
源码游标实际按字节推进，集成时应使用返回的游标，不自行按字符/行推算。

另有 isolated-session 后台接口，返回 202 和 run handle；其取消可能覆盖共享进程组，
仍需单独验证与 Pi Tool 的边界。不能用一个 API 路径的观察概括全部模式。
当前 `Controller.Execute` 从 `context.Background()` 建立执行上下文，因此也不能只凭
`runCommand` 的取消注释断言 HTTP 断线必然杀命令。
统一执行 API 与 Docker/Kubernetes 等运行后端的分离值得借鉴，见
[官方说明](https://github.com/opensandbox-group/OpenSandbox)。其 Node Agent 的 CRI 日志/OSS
采集是另一种观察数据管线，不能直接充当操作完成结果或 exactly-once 执行权威。

### NVIDIA OpenShell

公开协议 `ExecSandbox` 以 gRPC 流返回 stdout、stderr 和 exit；还支持交互流和 SSH。
v0.1.2 与所查 main 的 `request_id` 注释均明确：重复请求不会重新启动，也不会自动重连
或重放旧输出；未确认执行保持 fenced，已确认终态的 fence 保留 24 小时。
参见[公开协议](https://github.com/NVIDIA/OpenShell/blob/v0.1.2/proto/openshell.proto)。
请求去重和结果恢复由此可见是两份不同合同。

[当前架构](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/docs/about/architecture.mdx)
把可信 supervisor 放在工作负载之外，通过共同协议连接 sandbox；不同驱动选择 Unix
socket、TCP 或 vsock。这比把平台回包写进每种虚拟化后端更接近可复用边界。
不过内部进程 handle/保留输出能力不能直接当成公开 API 的无限恢复承诺；客户端连接与
supervisor 到 sandbox 的控制连接也不是同一故障边界。

### SandboxFusion

ByteDance 的 `/run_code` 等待执行器返回，再给 HTTP JSON：状态、编译/运行的退出码、
stdout/stderr，以及选定文件的 base64。Jupyter 路径另有 cell/display 结果。
这是代码执行/评测接口，不等同于长期 coding Workspace 的执行交付系统。
核对[服务端](https://github.com/bytedance/SandboxFusion/blob/469de0845cb7d665bc68044d541aa3aa28c5b30a/sandbox/server/sandbox_api.py)
及[结果类型](https://github.com/bytedance/SandboxFusion/blob/469de0845cb7d665bc68044d541aa3aa28c5b30a/sandbox/runners/types.py)。

### Daytona：保留接口参考，排除为当前完整开源后端的默认候选

其[官方仓库](https://github.com/daytonaio/daytona)明确说核心开发自 June 2026 转向私有代码库，
公开旧仓库不再维护；当前 `daytona/clients` 仍发布 SDK/CLI。
[公开接口](https://www.daytona.io/docs/en/typescript-sdk/process/)提供同步执行结果，以及
session 异步命令的 cmdId、状态和日志查询；[日志流](https://www.daytona.io/docs/en/log-streaming/)
经 WebSocket 交给 SDK 回调。不能据此确认当前私有服务端的日志存储布局或重启恢复实现。
SDK 的 `onStdout` 回调是客户端消费输出，不是服务端替 PiCloud 向 Kafka 投递最终结果。

这些常用接口没有提供可直接替代 PiCloud 全套合同的、面向原 Worker boot 的 Kafka
Tool-completion sink；这是对已查接口的结论，不是声称项目内部绝不使用消息队列。
Cube、E2B、OpenSandbox、OpenShell、SandboxFusion 根许可声明 Apache-2.0（各自第三方
组件另计）；Daytona 当前 clients 的 SDK 部分为 Apache-2.0、CLI 为 AGPL-3.0，核心私有
不能因为 SDK 公开就称为可直接采用的持续维护开源运行时。许可依据见清单中的官方文件。

## 对 PiCloud 的意义

需要分别问三件事：命令是否已经执行，结果是否仍能完整读取，结果是否已经交给 Pi 并
成为 canonical history。后台 ID、TCP 重连、成功退出码，各自只回答其中一部分。

如果实际决定支持第二后端，可讨论以下边界，而不改变 PG/Kafka/Pi 的既有权威：

1. Compute/Workspace Provider 管创建、连接、文件存储、销毁和物理证据。
2. PiCloud-owned 执行合同管接管、operation identity、目的端拒绝旧请求、取消和 UNKNOWN。
   Cube 用其扩展实现；其他后端能利用的原生 API 由各自适配器接入。
3. 公共可信结果适配保留固定 Node Tool framing、图片 claim check、Kafka reply 和原 Worker
   关联。普通进度仍走 lossy HTTP/SSE；Pi 仍拥有最终 Tool Result。

这描述职责，不是在本轮增加三个服务。若另设执行接管组件，它必须独立于 Projector
的生存期，否则会失去现有的接管后独立完成能力。移动代码不能消除这一责任。
沙箱 API 能提供完整 retained output 时，桥接器可以使用它而不修改厂商核心；缺少稳定
身份、可信取消或目的端 fencing 时仍可能需要扩展。不能承诺所有后端都可零修改接入。
也不能通过让 guest 持有 Kafka/S3 长期凭据来省掉可信边界。

运行时返回的 stdout/exitCode 还不是 Pi 的 Tool Result。为保持 read/write/edit/bash 与
原生 Pi 对齐，其他沙箱应运行现有固定 Tool 包，或证明另一实现完整等价。
Provider 的输出截断、kill(PID)、共享 session 进程组和超时规则均不能直接替代 Pi 的规则。
Workspace 持久存储、无 VM 文件浏览、预览/终端、VM 删除确认和恢复胶囊也要纳入替换范围。

我倾向于保留已验证架构；若出现真实第二后端需求，先在隔离环境验证其公开接口是否能
兑现这份执行合同，再决定需要抽出哪些接口。最低验收包括：提交 ACK 丢失、Projector
重启、输出连接断开、结果发布 ACK 丢失、执行器/节点消失、取消与完成竞争、旧请求迟到、
大图与完整结果、原 Worker boot 退场，以及 Workspace/隔离边界。
新增后端或改变这些合同应先提交新 ADR；本研究不授权恢复 Broker、添加 Tool PG ledger、
第二执行日志、通用任务调度器或静默降级运行时。
