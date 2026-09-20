# 结构盘点（5d1e8bf5）

2026-09-20。基于 Git 跟踪文件，不含 node_modules、构建产物及 Claude 原始日志。
这是检索盘点，不等于所有文件已经逐行审阅。引用数量包含原始 SQL、注释和直接调用，不能仅凭一次检索决定删除。

## 规模

| 类别 | 文件数 | 行数 |
| --- | ---: | ---: |
| source | 424 | 97850 |
| tests | 175 | 48600 |
| scripts | 87 | 26190 |
| adr | 50 | 2903 |
| migrations | 146 | 11400 |

source 包含 migrations 的 11400 行，不能把全部 source 都说成 Agent 业务逻辑。
有 20 个 workspace package；数据库类型声明含 67 个关系（其中两个是 View）。
生产 catalog 只读核对为 67 张 BASE TABLE（含两张 Kysely 迁移表）和 2 个 VIEW，即 65 张业务表。
CONFIGURATION.md 提及 80 个不同 PI_CLOUD_* 名称，不等于安装者必须手填这么多配置。

## 数据关系与源代码引用

View：active_execution_scopes、pi_session_visible_entries。没有独立持久化副本。
检索排除了 database-types.ts、测试与历史迁移。代表位置最多三个文件，不是全部调用者。

| 关系 | 职责分类 | 引用数 | 代表位置 |
| --- | --- | ---: | --- |
| accepted_fact_projection_offsets | 输出投影进度 | 4 | [accepted-fact-recovery.ts:12](../packages/runtime-core/src/accepted-fact-recovery.ts#L12)，[kafka-safe-retention.ts:15](../packages/runtime-core/src/kafka-safe-retention.ts#L15) |
| agent_definitions | 运行配置 | 2 | [run-cancellation-executor.ts:353](../packages/runtime-core/src/run-cancellation-executor.ts#L353)，[run-executor.ts:670](../packages/runtime-core/src/run-executor.ts#L670) |
| agent_revisions | 运行配置 | 3 | [run-cancellation-executor.ts:348](../packages/runtime-core/src/run-cancellation-executor.ts#L348)，[run-executor.ts:553](../packages/runtime-core/src/run-executor.ts#L553) |
| source_control_installations | 代码托管集成 | 12 | [source-control-service.ts:224](../packages/control-plane/src/source-control-service.ts#L224) |
| source_control_repositories | 代码托管集成 | 15 | [source-control-issue-coordinator.ts:404](../packages/control-plane/src/source-control-issue-coordinator.ts#L404)，[source-control-service.ts:231](../packages/control-plane/src/source-control-service.ts#L231) |
| source_control_webhook_deliveries | 代码托管集成 | 13 | [source-control-issue-coordinator.ts:358](../packages/control-plane/src/source-control-issue-coordinator.ts#L358)，[source-control-service.ts:872](../packages/control-plane/src/source-control-service.ts#L872) |
| source_control_issue_jobs | 代码托管集成 | 25 | [control-plane-store.ts:865](../packages/control-plane/src/control-plane-store.ts#L865)，[source-control-issue-coordinator.ts:90](../packages/control-plane/src/source-control-issue-coordinator.ts#L90)，[source-control-service.ts:522](../packages/control-plane/src/source-control-service.ts#L522) |
| source_control_issue_claims | 代码托管集成 | 7 | [source-control-service.ts:554](../packages/control-plane/src/source-control-service.ts#L554) |
| source_control_credentials | 代码托管集成 | 3 | [source-control-service.ts:306](../packages/control-plane/src/source-control-service.ts#L306) |
| sandbox_domains | 执行环境与文件 | 21 | [control-plane-store.ts:332](../packages/control-plane/src/control-plane-store.ts#L332)，[development-environment-service.ts:419](../packages/control-plane/src/development-environment-service.ts#L419)，[production-bootstrap.ts:44](../packages/control-plane/src/production-bootstrap.ts#L44) |
| tool_broker_instances | 执行环境与文件 | 16 | [development-environment-service.ts:1063](../packages/control-plane/src/development-environment-service.ts#L1063)，[workspace-terminal-gateway.ts:452](../packages/control-plane/src/workspace-terminal-gateway.ts#L452)，[tool-command-routes.ts:28](../packages/tool-broker/src/tool-command-routes.ts#L28) |
| tool_broker_workspace_runtimes | 执行环境与文件 | 27 | [sandbox-preview-gateway.ts:505](../packages/control-plane/src/sandbox-preview-gateway.ts#L505)，[source-control-service.ts:1570](../packages/control-plane/src/source-control-service.ts#L1570)，[workspace-runtime-state-repository.ts:740](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L740) |
| tool_broker_operations | 执行环境与文件 | 6 | [workspace-runtime-state-repository.ts:1764](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L1764) |
| tool_broker_binding_routes | 执行环境与文件 | 2 | [tool-command-routes.ts:27](../packages/tool-broker/src/tool-command-routes.ts#L27)，[workspace-runtime-state-repository.ts:471](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L471) |
| sandbox_http_services | 执行环境与文件 | 8 | [sandbox-preview-gateway.ts:498](../packages/control-plane/src/sandbox-preview-gateway.ts#L498)，[sandbox-http-service-registry.ts:53](../packages/tool-broker/src/sandbox-http-service-registry.ts#L53)，[workspace-runtime-state-repository.ts:1281](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L1281) |
| workspace_terminal_sessions | 执行环境与文件 | 17 | [control-plane-store.ts:808](../packages/control-plane/src/control-plane-store.ts#L808)，[source-control-service.ts:1580](../packages/control-plane/src/source-control-service.ts#L1580)，[workspace-runtime-state-repository.ts:645](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L645) |
| development_environments | 执行环境与文件 | 45 | [control-plane-store.ts:434](../packages/control-plane/src/control-plane-store.ts#L434)，[development-environment-service.ts:177](../packages/control-plane/src/development-environment-service.ts#L177)，[sandbox-preview-gateway.ts:422](../packages/control-plane/src/sandbox-preview-gateway.ts#L422) |
| development_environment_operations | 执行环境与文件 | 6 | [control-plane-store.ts:1422](../packages/control-plane/src/control-plane-store.ts#L1422)，[development-environment-service.ts:230](../packages/control-plane/src/development-environment-service.ts#L230) |
| conversation_workspace_rebind_operations | 产品会话与生命周期 | 2 | [control-plane-store.ts:1015](../packages/control-plane/src/control-plane-store.ts#L1015) |
| ssh_access_tickets | 执行环境与文件 | 3 | [ssh-access-ticket-service.ts:110](../packages/control-plane/src/ssh-access-ticket-service.ts#L110)，[ticket-authority.ts:34](../packages/ssh-gateway/src/ticket-authority.ts#L34) |
| tenants | 账号与租户 | 13 | [production-bootstrap.ts:80](../packages/control-plane/src/production-bootstrap.ts#L80)，[source-control-issue-coordinator.ts:405](../packages/control-plane/src/source-control-issue-coordinator.ts#L405)，[tenant-administration.ts:139](../packages/control-plane/src/tenant-administration.ts#L139) |
| users | 账号与租户 | 13 | [conversation-tree-service.ts:153](../packages/control-plane/src/conversation-tree-service.ts#L153)，[production-bootstrap.ts:92](../packages/control-plane/src/production-bootstrap.ts#L92)，[source-control-issue-coordinator.ts:406](../packages/control-plane/src/source-control-issue-coordinator.ts#L406) |
| tenant_runtime_policies | 账号与租户 | 19 | [control-plane-store.ts:590](../packages/control-plane/src/control-plane-store.ts#L590)，[conversation-tree-service.ts:1215](../packages/control-plane/src/conversation-tree-service.ts#L1215)，[development-environment-service.ts:367](../packages/control-plane/src/development-environment-service.ts#L367) |
| tenant_api_credentials | 账号与租户 | 8 | [production-bootstrap.ts:260](../packages/control-plane/src/production-bootstrap.ts#L260)，[tenant-administration.ts:295](../packages/control-plane/src/tenant-administration.ts#L295)，[tenant-identity.ts:157](../packages/control-plane/src/tenant-identity.ts#L157) |
| user_password_credentials | 账号与租户 | 6 | [platform-administrator.ts:24](../packages/control-plane/src/platform-administrator.ts#L24)，[source-control-issue-coordinator.ts:411](../packages/control-plane/src/source-control-issue-coordinator.ts#L411)，[tenant-administration.ts:308](../packages/control-plane/src/tenant-administration.ts#L308) |
| web_sessions | 账号与租户 | 6 | [web-authentication.ts:339](../packages/control-plane/src/web-authentication.ts#L339) |
| projects | 项目/环境配置 | 29 | [control-plane-store.ts:250](../packages/control-plane/src/control-plane-store.ts#L250)，[control-plane.controller.ts:267](../packages/control-plane/src/control-plane.controller.ts#L267)，[conversation-reader.ts:54](../packages/control-plane/src/conversation-reader.ts#L54) |
| environment_versions | 项目/环境配置 | 13 | [control-plane-store.ts:281](../packages/control-plane/src/control-plane-store.ts#L281)，[conversation-reader.ts:530](../packages/control-plane/src/conversation-reader.ts#L530)，[development-environment-service.ts:464](../packages/control-plane/src/development-environment-service.ts#L464) |
| environment_validations | 项目/环境配置 | 3 | [conversation-reader.ts:557](../packages/control-plane/src/conversation-reader.ts#L557)，[run-executor.ts:1090](../packages/runtime-core/src/run-executor.ts#L1090)，[workspace-runtime-state-repository.ts:1690](../packages/tool-broker/src/workspace-runtime-state-repository.ts#L1690) |
| environment_operations | 项目/环境配置 | 0 | 未发现 |
| workspaces | 执行环境与文件 | 85 | [control-plane-store.ts:271](../packages/control-plane/src/control-plane-store.ts#L271)，[control-plane.controller.ts:369](../packages/control-plane/src/control-plane.controller.ts#L369)，[conversation-archive-service.ts:180](../packages/control-plane/src/conversation-archive-service.ts#L180) |
| workspace_operations | 执行环境与文件 | 2 | [conversation-archive-service.ts:230](../packages/control-plane/src/conversation-archive-service.ts#L230) |
| workspace_delete_operations | 执行环境与文件 | 4 | [control-plane-store.ts:741](../packages/control-plane/src/control-plane-store.ts#L741)，[development-environment-service.ts:782](../packages/control-plane/src/development-environment-service.ts#L782) |
| credential_bindings | 运行配置 | 13 | [control-plane-store.ts:1857](../packages/control-plane/src/control-plane-store.ts#L1857)，[model-profile-catalog.ts:89](../packages/control-plane/src/model-profile-catalog.ts#L89)，[platform-model-configuration.ts:24](../packages/control-plane/src/platform-model-configuration.ts#L24) |
| model_profiles | 运行配置 | 15 | [control-plane-store.ts:591](../packages/control-plane/src/control-plane-store.ts#L591)，[main.ts:58](../packages/control-plane/src/main.ts#L58)，[model-profile-catalog.ts:88](../packages/control-plane/src/model-profile-catalog.ts#L88) |
| sessions | 产品会话与生命周期 | 114 | [assignment-reconciler.ts:292](../packages/control-plane/src/assignment-reconciler.ts#L292)，[control-plane-store.ts:420](../packages/control-plane/src/control-plane-store.ts#L420)，[control-plane.controller.ts:216](../packages/control-plane/src/control-plane.controller.ts#L216) |
| subagent_executions | 输出投影进度 | 43 | [control-plane-store.ts:845](../packages/control-plane/src/control-plane-store.ts#L845)，[conversation-archive-service.ts:149](../packages/control-plane/src/conversation-archive-service.ts#L149)，[conversation-reader.ts:399](../packages/control-plane/src/conversation-reader.ts#L399) |
| subagent_control_commands | 输出投影进度 | 16 | [subagent-controller.ts:22](../packages/control-plane/src/subagent-controller.ts#L22) |
| subagent_supervisor_requests | 输出投影进度 | 11 | [subagent-controller.ts:281](../packages/control-plane/src/subagent-controller.ts#L281)，[postgres-subagent-supervisor-channel.ts:72](../packages/trusted-tool-runtime/src/postgres-subagent-supervisor-channel.ts#L72) |
| conversation_prune_operations | 产品会话与生命周期 | 2 | [conversation-tree-service.ts:741](../packages/control-plane/src/conversation-tree-service.ts#L741) |
| turns | 产品会话与生命周期 | 121 | [assignment-reconciler.ts:291](../packages/control-plane/src/assignment-reconciler.ts#L291)，[control-plane-store.ts:643](../packages/control-plane/src/control-plane-store.ts#L643)，[control-plane.controller.ts:731](../packages/control-plane/src/control-plane.controller.ts#L731) |
| runs | 调度、所有权与恢复 | 117 | [assignment-reconciler.ts:293](../packages/control-plane/src/assignment-reconciler.ts#L293)，[control-plane-store.ts:1228](../packages/control-plane/src/control-plane-store.ts#L1228)，[control-plane.controller.ts:656](../packages/control-plane/src/control-plane.controller.ts#L656) |
| run_transitions | 调度、所有权与恢复 | 3 | [control-plane-store.ts:1256](../packages/control-plane/src/control-plane-store.ts#L1256)，[run-executor.ts:932](../packages/runtime-core/src/run-executor.ts#L932)，[run-state.ts:66](../packages/runtime-core/src/run-state.ts#L66) |
| sandboxes | 执行环境与文件 | 47 | [assignment-reconciler.ts:224](../packages/control-plane/src/assignment-reconciler.ts#L224)，[main.ts:212](../packages/control-plane/src/main.ts#L212)，[subagent-controller.ts:87](../packages/control-plane/src/subagent-controller.ts#L87) |
| supervisor_connections | 调度、所有权与恢复 | 14 | [supervisor-connection-manager.ts:376](../packages/control-plane/src/supervisor-connection-manager.ts#L376)，[session-lease-coordinator.ts:215](../packages/runtime-core/src/session-lease-coordinator.ts#L215) |
| supervisor_boot_credentials | 调度、所有权与恢复 | 4 | [supervisor-boot-provisioner.ts:344](../packages/control-plane/src/supervisor-boot-provisioner.ts#L344) |
| supervisor_hosts | 调度、所有权与恢复 | 6 | [main.ts:211](../packages/control-plane/src/main.ts#L211)，[subagent-controller.ts:88](../packages/control-plane/src/subagent-controller.ts#L88)，[supervisor-boot-provisioner.ts:267](../packages/control-plane/src/supervisor-boot-provisioner.ts#L267) |
| sandbox_retirements | 执行环境与文件 | 6 | [supervisor-connection-manager.ts:990](../packages/control-plane/src/supervisor-connection-manager.ts#L990) |
| session_leases | 调度、所有权与恢复 | 31 | [assignment-reconciler.ts:316](../packages/control-plane/src/assignment-reconciler.ts#L316)，[supervisor-connection-manager.ts:828](../packages/control-plane/src/supervisor-connection-manager.ts#L828)，[postgres-execution-authority.ts:67](../packages/pi-session-postgres/src/postgres-execution-authority.ts#L67) |
| active_execution_scopes | 调度、所有权与恢复 | 10 | [assignment-reconciler.ts:263](../packages/control-plane/src/assignment-reconciler.ts#L263)，[turn-steering-service.ts:337](../packages/control-plane/src/turn-steering-service.ts#L337)，[run-executor.ts:527](../packages/runtime-core/src/run-executor.ts#L527) |
| turn_control_requests | 调度、所有权与恢复 | 22 | [assignment-reconciler.ts:419](../packages/control-plane/src/assignment-reconciler.ts#L419)，[control-plane-store.ts:1679](../packages/control-plane/src/control-plane-store.ts#L1679)，[turn-steering-service.ts:220](../packages/control-plane/src/turn-steering-service.ts#L220) |
| conversation_fork_operations | 产品会话与生命周期 | 2 | [conversation-tree-service.ts:1103](../packages/control-plane/src/conversation-tree-service.ts#L1103) |
| session_terminal_events | 产品会话与生命周期 | 6 | [postgres-native-session-host.ts:264](../packages/pi-session-postgres/src/postgres-native-session-host.ts#L264)，[project-native-session-append.ts:226](../packages/pi-session-postgres/src/project-native-session-append.ts#L226)，[canonical-pi-conversation.ts:392](../packages/runtime-core/src/canonical-pi-conversation.ts#L392) |
| outbox | 调度、所有权与恢复 | 12 | [operational-metrics-sampler.ts:80](../packages/control-plane/src/operational-metrics-sampler.ts#L80)，[index.ts:586](../packages/protocol/src/index.ts#L586)，[accepted-fact-terminal-outbox-relay.ts:53](../packages/runtime-core/src/accepted-fact-terminal-outbox-relay.ts#L53) |
| usage_ledger | 历史计费候选 | 0 | 未发现 |
| model_rates | 历史计费候选 | 4 | [model-profile-catalog.ts:160](../packages/control-plane/src/model-profile-catalog.ts#L160)，[production-bootstrap.ts:170](../packages/control-plane/src/production-bootstrap.ts#L170)，[tenant-administration.ts:273](../packages/control-plane/src/tenant-administration.ts#L273) |
| model_requests | 历史计费候选 | 1 | [assignment-reconciler.ts:408](../packages/control-plane/src/assignment-reconciler.ts#L408) |
| platform_runtime_settings | 运行配置 | 3 | [platform-runtime-settings.ts:120](../packages/control-plane/src/platform-runtime-settings.ts#L120) |
| platform_runtime_setting_changes | 运行配置 | 1 | [platform-runtime-settings.ts:163](../packages/control-plane/src/platform-runtime-settings.ts#L163) |
| pi_sessions | Pi 语义日志/查询投影 | 31 | [assignment-reconciler.ts:303](../packages/control-plane/src/assignment-reconciler.ts#L303)，[control-plane-store.ts:552](../packages/control-plane/src/control-plane-store.ts#L552)，[conversation-tree-service.ts:1019](../packages/control-plane/src/conversation-tree-service.ts#L1019) |
| pi_session_lanes | Pi 语义日志/查询投影 | 23 | [control-plane-store.ts:563](../packages/control-plane/src/control-plane-store.ts#L563)，[conversation-tree-service.ts:215](../packages/control-plane/src/conversation-tree-service.ts#L215)，[postgres-session-projection-rebuilder.ts:162](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L162) |
| pi_session_entries | Pi 语义日志/查询投影 | 16 | [conversation-tree-service.ts:242](../packages/control-plane/src/conversation-tree-service.ts#L242)，[subagent-controller.ts:507](../packages/control-plane/src/subagent-controller.ts#L507)，[postgres-session-projection-rebuilder.ts:169](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L169) |
| pi_session_entry_refs | Pi 语义日志/查询投影 | 4 | [conversation-tree-service.ts:1324](../packages/control-plane/src/conversation-tree-service.ts#L1324)，[postgres-session-projection-rebuilder.ts:147](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L147)，[postgres-session-repository.ts:403](../packages/pi-session-postgres/src/postgres-session-repository.ts#L403) |
| pi_session_visible_entries | Pi 语义日志/查询投影 | 17 | [conversation-reader.ts:425](../packages/control-plane/src/conversation-reader.ts#L425)，[conversation-tree-service.ts:223](../packages/control-plane/src/conversation-tree-service.ts#L223)，[postgres-native-session-host.ts:124](../packages/pi-session-postgres/src/postgres-native-session-host.ts#L124) |
| pi_session_records | Pi 语义日志/查询投影 | 20 | [conversation-tree-service.ts:996](../packages/control-plane/src/conversation-tree-service.ts#L996)，[postgres-native-session-host.ts:125](../packages/pi-session-postgres/src/postgres-native-session-host.ts#L125)，[postgres-session-projection-rebuilder.ts:157](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L157) |
| pi_session_labels | Pi 语义日志/查询投影 | 11 | [conversation-tree-service.ts:1395](../packages/control-plane/src/conversation-tree-service.ts#L1395)，[postgres-session-projection-rebuilder.ts:152](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L152)，[postgres-session-repository.ts:486](../packages/pi-session-postgres/src/postgres-session-repository.ts#L486) |
| pi_session_log | Pi 语义日志/查询投影 | 16 | [conversation-tree-service.ts:1033](../packages/control-plane/src/conversation-tree-service.ts#L1033)，[postgres-session-projection-rebuilder.ts:62](../packages/pi-session-postgres/src/postgres-session-projection-rebuilder.ts#L62)，[postgres-session-repository.ts:84](../packages/pi-session-postgres/src/postgres-session-repository.ts#L84) |

## 生产 package 依赖

按 package.json 的 dependencies 建图，未发现环；devDependencies 的反向测试依赖不算生产环。
无环不代表职责合理：Control Plane 经 runtime-core 依赖到具体 Pi Runner 和 fake-model-server。

| Package | 生产内部依赖 | 测试内部依赖 |
| --- | --- | --- |
| control-plane | database, domain, observability, protocol, runtime-core, sandbox-supervisor, tool-broker, trusted-tool-runtime, workspace-runtime | — |
| cube-api-authorizer | — | — |
| cube-egress-gateway | — | — |
| database | domain | — |
| domain | protocol | — |
| event-log | observability | — |
| fake-model-server | — | — |
| observability | — | — |
| pi-session-postgres | database, protocol | — |
| protocol | — | — |
| provider-egress-relay | — | — |
| runtime-core | database, domain, event-log, observability, pi-session-postgres, protocol, sandbox-supervisor | — |
| sandbox-supervisor | fake-model-server, observability, pi-session-postgres, protocol, workspace-runtime | — |
| ssh-gateway | database, protocol | — |
| supervisor-host | database, observability, pi-session-postgres, protocol, runtime-core, tool-broker, trusted-tool-runtime, sandbox-supervisor, workspace-runtime | control-plane |
| tool-broker | database, observability, protocol, workspace-runtime | — |
| tool-sandbox | protocol, workspace-runtime | — |
| trusted-tool-runtime | database, pi-session-postgres, protocol, sandbox-supervisor | control-plane |
| web-ui | protocol | — |
| workspace-runtime | protocol | — |

## 大文件（不含迁移、测试）

- [packages/tool-broker/src/tool-broker.ts](../packages/tool-broker/src/tool-broker.ts)：2798 行。
- [packages/web-ui/src/ChatApp.tsx](../packages/web-ui/src/ChatApp.tsx)：2301 行。
- [packages/tool-broker/src/workspace-runtime-state-repository.ts](../packages/tool-broker/src/workspace-runtime-state-repository.ts)：2282 行。
- [packages/tool-broker/src/cubesandbox-sandbox-provider.ts](../packages/tool-broker/src/cubesandbox-sandbox-provider.ts)：2247 行。
- [packages/control-plane/src/source-control-service.ts](../packages/control-plane/src/source-control-service.ts)：2152 行。
- [packages/control-plane/src/control-plane-store.ts](../packages/control-plane/src/control-plane-store.ts)：2015 行。
- [packages/protocol/src/control-plane-api.ts](../packages/protocol/src/control-plane-api.ts)：1583 行。
- [packages/control-plane/src/conversation-tree-service.ts](../packages/control-plane/src/conversation-tree-service.ts)：1578 行。
- [packages/runtime-core/src/run-executor.ts](../packages/runtime-core/src/run-executor.ts)：1268 行。
- [packages/tool-broker/src/cubesandbox-runtime-client.ts](../packages/tool-broker/src/cubesandbox-runtime-client.ts)：1263 行。
- [packages/control-plane/src/supervisor-connection-manager.ts](../packages/control-plane/src/supervisor-connection-manager.ts)：1215 行。
- [packages/database/src/database-types.ts](../packages/database/src/database-types.ts)：1206 行。
- [packages/pi-session-postgres/src/cloud-agent-runtime.ts](../packages/pi-session-postgres/src/cloud-agent-runtime.ts)：1173 行。
- [packages/tool-broker/src/tool-broker-server.ts](../packages/tool-broker/src/tool-broker-server.ts)：1147 行。

## Controller 路由

只列装饰器注册的 REST/SSE 路由；不含 Fastify 直接注册的内部管理、Preview、WebSocket 和 health 接口。

| 方法 | /v1 下路径 |
| --- | --- |
| GET | auth/providers |
| POST | auth/register |
| POST | auth/login |
| POST | auth/logout |
| POST | registrations |
| GET | identity |
| GET | model-configuration |
| PUT | model-configuration |
| GET | models |
| GET | sessions/:sessionId/model |
| PUT | sessions/:sessionId/model |
| GET | platform-settings/cube-proxy |
| PUT | platform-settings/cube-proxy |
| GET | internal/cube-egress-configuration |
| POST | projects |
| GET | source-control |
| POST | source-control/installations/:installationId/refresh |
| POST | source-control/gitlab/projects |
| GET | source-control/issue-jobs |
| POST | source-control/issue-jobs/:jobId/claims |
| DELETE | source-control/issue-jobs/:jobId/claims |
| POST | source-control/issue-jobs/:jobId/start |
| POST | source-control/issue-jobs/:jobId/git-preflight |
| GET | workspaces/:workspaceId/code-host-connections |
| POST | workspaces/:workspaceId/code-host-connections |
| DELETE | workspaces/:workspaceId/code-host-connections |
| POST | source-control/github/webhook |
| POST | source-control/gitlab/webhook |
| GET | conversations |
| GET | workspaces |
| GET | development-environments |
| POST | development-environments |
| GET | development-environments/:environmentId/directory |
| POST | development-environments/:environmentId/directory |
| POST | development-environments/:environmentId/actions |
| DELETE | workspaces/:workspaceId |
| DELETE | conversations/:sessionId |
| PUT | conversations/:sessionId/workspace |
| POST | conversations/:sessionId/ssh-tickets |
| GET | conversations/:sessionId |
| GET | conversations/:sessionId/tree |
| POST | conversations/:sessionId/forks |
| POST | conversations/:sessionId/prunes |
| GET | runs/:runId |
| GET | sessions/:sessionId/workspace/directory |
| GET | sessions/:sessionId/workspace/file |
| POST | projects/:projectId/sessions |
| POST | sessions/:sessionId/turns |
| POST | sessions/:sessionId/turns/:turnId/cancellations |
| POST | sessions/:sessionId/turns/:turnId/steers |
| GET | sessions/:sessionId/events |

