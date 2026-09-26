# Flash 重新上架与 Pro 菜单下架

日期：2026-09-26。实现与部署版本：`65a1180ef1ca4c4fda9ec89105d4fb0cf9e2fdcb`。
依据：[ADR-0191 修订](../adr/0191-gpt6-model-catalog.md)。

## 行为

按用户要求，会话和管理页面重新提供 DeepSeek V4.1 Flash，隐藏 DeepSeek V4 Pro。
Flash 使用现有 Responses 路线，声明 `hostedTools: ["web_search"]`，保留文本和图片输入。
内部模型 ID 仍为 `deepseek-v4-flash`，官方当前将它路由到 `deepseek-flash`（V4.1）。

该声明目前会被官方接受并忽略，不等于搜索已经恢复。只有实际返回的搜索事件才进入
搜索活动与历史；没有添加搜索代理、备用搜索工具或切换到 Messages 协议。

这次下架是模型选择目录调整。历史和已签发的模型身份保留；没有把 Pro 请求自动
改名为 Flash。切换前后均确认没有 Session 的目标模型或租户默认配置选中 Pro。
数据库保持 migration 152，没有 schema 或数据迁移。

## 验证

- 全工作区类型检查通过。
- 相关五个测试文件 **52/52** 通过：公共模型目录、Worker 模型网关、搜索声明、
  原生 TurnRunner 集成和模型菜单设置。覆盖参数原样转发、凭据作用域、撤销、
  超时、原生回放及现有输入生命周期；本次没有重复执行全仓测试或整个故障矩阵。
- 文档、格式、脚本语法、Compose 配置、镜像依赖闭包检查通过；应用镜像构建成功。
- 通过部署中的 CLIProxyAPI 请求旧 Flash ID，并携带 `tools: [{type: "web_search"}]`：
  HTTP **200**，返回模型 `deepseek-flash`，精确回复测试标记，搜索事件为零。
- 真实 Chrome 登录专用测试账户，DeepSeek 子菜单只出现 **DeepSeek V4.1 Flash**，
  Pro 不出现；实际点击 Flash 和关闭思考后，Session 模型保存成功。
- Flash 在 Cube 中实际执行 Bash 生成随机四位数字图片，再用原生 `read` 读取。
  图片附件为 **3,205,863 字节 PNG**，最终数字回答正确。预期数字在模型回答后，
  由独立 Workspace 文件 API 读取，未作为提示或工具文本答案提供给模型。
  该 Run completed，工具列表恰为 Bash、read，未产生虚假的 hosted search 活动。

[结构化验收与部署记录](flash-catalog-20260926.json)包含准确版本、容器、模板、
图像字节数、运行结果和清理状态，不包含凭据或会话正文。

## 部署与清理

在零未完成 Run、零未释放 lease、零未封口 Session 时切换 API、两个 Compose Worker、
Tool Broker 和 Web；五个容器均健康且 revision 一致，关键模型目录源码摘要一致。
Cube guest 构建身份为 `14f89c9518957b49663901f025757dd0db8e4c86`，四种模板均 READY。
PG、Kafka、Provider Gateway 和图片存储未重启。

测试会话已归档，Workspace 已删除且存储清理完成，浏览器和脚本均退出登录。原生历史按现有保留
合同继续引用这张测试图片。模板保留流程删除四个旧模板；十一项既有旧节点清理失败
仍属于运维 backlog，不影响本次新模板验收。

从正常安装的当前版本复验时，在模型菜单选择 Flash，让 Agent 在测试 Workspace
生成一张随机数字图片后调用 `read`，检查最终识别结果；不要将菜单可见或请求成功
当作内置搜索已经恢复的证明。
