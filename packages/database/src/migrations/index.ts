import type { MigrationProvider } from "kysely/migration";
import * as initialControlPlane from "./001_initial_control_plane.ts";
import * as durableEventDelivery from "./002_durable_event_delivery.ts";
import * as explicitSessionMailbox from "./003_explicit_session_mailbox.ts";
import * as supervisorConnectionHealth from "./004_supervisor_connection_health.ts";
import * as supervisorBootCredentials from "./005_supervisor_boot_credentials.ts";
import * as privateMultiTenantIdentity from "./006_private_multi_tenant_identity.ts";
import * as encryptedTenantModelCredentials from "./007_encrypted_tenant_model_credentials.ts";
import * as controlledWorkspaceSources from "./008_controlled_workspace_sources.ts";
import * as durableRunsAndAttempts from "./009_durable_runs_and_attempts.ts";
import * as versionedWorkspacesAndGitHubDelivery from "./010_versioned_workspaces_and_github_delivery.ts";
import * as contextAndModelGovernance from "./011_context_and_model_governance.ts";
import * as observabilityTraceIdentity from "./012_observability_trace_identity.ts";
import * as productAuthAndEmptyWorkspaces from "./013_product_auth_and_empty_workspaces.ts";
import * as removePerRunTokenBudget from "./014_remove_per_run_token_budget.ts";
import * as versionedProjectEnvironments from "./015_versioned_project_environments.ts";
import * as environmentRecipesAndOperations from "./016_environment_recipes_and_operations.ts";
import * as multiRepositorySourceSets from "./017_multi_repository_source_sets.ts";
import * as attemptRewindsAndReviewBundles from "./018_attempt_rewinds_and_review_bundles.ts";
import * as legacyEnvironmentValidationEvidence from "./019_legacy_environment_validation_evidence.ts";
import * as semanticConversationProjections from "./020_semantic_conversation_projections.ts";
import * as parallelCandidateRaces from "./021_parallel_candidate_races.ts";
import * as horizontalSupervisorPool from "./022_horizontal_supervisor_pool.ts";
import * as temporalWorkerAffinity from "./023_temporal_worker_affinity.ts";
import * as hotPlatformRuntimeSettings from "./024_hot_platform_runtime_settings.ts";
import * as largeWorkspaceCheckpoints from "./025_large_workspace_checkpoints.ts";
import * as workspaceFirstConversations from "./026_workspace_first_conversations.ts";
import * as sharedWorkspaceHeads from "./027_shared_workspace_heads.ts";
import * as interruptedPiConversations from "./028_interrupted_pi_conversations.ts";
import * as externalPlatformGitMetadata from "./029_external_platform_git_metadata.ts";
import * as activePiSteer from "./030_active_pi_steer.ts";
import * as typedToolOutcomes from "./031_typed_tool_outcomes.ts";
import * as modelSamplingStepIdentity from "./032_model_sampling_step_identity.ts";
import * as enterpriseExecutionCells from "./033_enterprise_execution_cells.ts";
import * as sandboxManagerOwnership from "./034_sandbox_manager_ownership.ts";
import * as partitionedSessionEventLog from "./035_partitioned_session_event_log.ts";
import * as fasterEventIdentityRegistration from "./036_faster_event_identity_registration.ts";
import * as executionCellWorkerRoutes from "./037_execution_cell_worker_routes.ts";
import * as workspaceCellMigrations from "./038_workspace_cell_migrations.ts";
import * as externalWorkerEventLog from "./039_external_worker_event_log.ts";
import * as sessionSandboxRetention from "./040_session_sandbox_retention.ts";
import * as decouplePersistentSandboxLeases from "./041_decouple_persistent_sandbox_leases.ts";
import * as kafkaFirstWorkerEventLog from "./042_kafka_first_worker_event_log.ts";
import * as sessionEventHotRetention from "./043_session_event_hot_retention.ts";
import * as canonicalConversationsAndLiveStreams from "./044_canonical_conversations_and_live_streams.ts";
import * as sandboxDomainsAndToolBroker from "./045_sandbox_domains_and_tool_broker.ts";
import * as temporalOutboxHandoff from "./046_temporal_outbox_handoff.ts";
import * as removeTemporalWorkerAffinity from "./047_remove_temporal_worker_affinity.ts";
import * as turnAdmissionIndex from "./048_turn_admission_index.ts";
import * as tenantSandboxQuota from "./049_tenant_sandbox_quota.ts";
import * as primaryToolBrokerRoute from "./050_primary_tool_broker_route.ts";
import * as bootstrapTenantSandboxQuota from "./051_bootstrap_tenant_sandbox_quota.ts";
import * as postgresRunQueue from "./052_postgres_run_queue.ts";
import * as piSessionStorage from "./053_pi_session_storage.ts";
import * as postgresCheckpointObjects from "./054_postgres_checkpoint_objects.ts";
import * as unlimitedDefaultDailyTokens from "./055_unlimited_default_daily_tokens.ts";
import * as codingRunModelRequestLimit from "./056_coding_run_model_request_limit.ts";
import * as conversationTreeForks from "./057_conversation_tree_forks.ts";
import * as workspaceDeletion from "./058_workspace_deletion.ts";
import * as piSessionOpaqueIdentifiers from "./059_pi_session_opaque_identifiers.ts";
import * as workspaceTerminalLeases from "./060_workspace_terminal_leases.ts";
import * as removeDormantAdvancedFeatures from "./061_remove_dormant_advanced_features.ts";
import * as postgresSessionStorageOnly from "./062_postgres_session_storage_only.ts";
import * as piCloudEnvironmentProfile from "./063_pi_cloud_environment_profile.ts";
import * as piCloudRunQueueNotification from "./064_pi_cloud_run_queue_notification.ts";
import * as runToolCapabilitySnapshots from "./065_run_tool_capability_snapshots.ts";
import * as durableSubagentExecutions from "./066_durable_subagent_executions.ts";
import * as toollessRunCapabilities from "./067_toolless_run_capabilities.ts";
import * as subagentRunSystemPrompt from "./068_subagent_run_system_prompt.ts";
import * as isolatedSubagentWorkspaces from "./069_isolated_subagent_workspaces.ts";
import * as conversationTailPruning from "./070_conversation_tail_pruning.ts";
import * as subagentSupervisorChannel from "./071_subagent_supervisor_channel.ts";
import * as sharedPiSessionEntries from "./072_shared_pi_session_entries.ts";
import * as recursiveSubagentTrees from "./073_recursive_subagent_trees.ts";
import * as userOwnedDevelopmentEnvironments from "./074_user_owned_development_environments.ts";
import * as canonicalPiConversationEntries from "./075_canonical_pi_conversation_entries.ts";
import * as postgresLiveEventAuthority from "./076_postgres_live_event_authority.ts";
import * as removeLegacyEventIdTrigger from "./077_remove_legacy_event_id_trigger.ts";
import * as kafkaFirstAgentEventLog from "./078_kafka_first_agent_event_log.ts";
import * as removePostgresHotEventLog from "./079_remove_postgres_hot_event_log.ts";
import * as reconcileCodingModelLimits from "./080_reconcile_coding_model_limits.ts";
import * as developmentEnvironmentProfiles from "./081_development_environment_profiles.ts";
import * as workspaceTerminalFencing from "./082_workspace_terminal_fencing.ts";
import * as removeDuplicateCompactionLedger from "./083_remove_duplicate_compaction_ledger.ts";
import * as conversationWorkspaceRebinding from "./084_conversation_workspace_rebinding.ts";
import * as sshAccessTickets from "./085_ssh_access_tickets.ts";
import * as sessionExecutionProfiles from "./086_session_execution_profiles.ts";
import * as developmentEnvironmentMachineIdentity from "./087_development_environment_machine_identity.ts";
import * as exclusiveVmState from "./088_exclusive_vm_state.ts";
import * as exclusiveMachineWorkingDirectories from "./089_exclusive_machine_working_directories.ts";
import * as developmentEnvironmentRecoveryIdentity from "./090_development_environment_recovery_identity.ts";
import * as executionGrants from "./091_execution_grants.ts";
import * as sandboxHttpServices from "./092_sandbox_http_services.ts";
import * as machineOwnedWorkspaces from "./093_machine_owned_workspaces.ts";
import * as agentEventWriterChannels from "./094_agent_event_writer_channels.ts";
import * as factChannels from "./095_fact_channels.ts";
import * as sessionKafkaHeads from "./096_session_kafka_heads.ts";
import * as sessionLeaseFencing from "./097_session_lease_fencing.ts";
import * as removeRepositoryImport from "./098_remove_repository_import.ts";
import * as removeDormantApprovalGraph from "./099_remove_dormant_approval_graph.ts";
import * as removeLegacyDatabaseFunctions from "./100_remove_legacy_database_functions.ts";
import * as userManagedWorkspaceConcurrency from "./101_user_managed_workspace_concurrency.ts";
import * as workspaceToolRuntimeSlot from "./102_workspace_tool_runtime_slot.ts";
import * as runQueueAuthority from "./103_run_queue_authority.ts";
import * as sourceControlAppAndIssueJobs from "./104_source_control_app_and_issue_jobs.ts";
import * as versionedAgentDefinitions from "./105_versioned_agent_definitions.ts";
import * as gitlabProjectConnections from "./106_gitlab_project_connections.ts";
import * as oidcIdentityAndIssueClaims from "./107_oidc_identity_and_issue_claims.ts";
import * as removePlatformGitChangeTracking from "./108_remove_platform_git_change_tracking.ts";
import * as removeLegacyWorkspacePatchOutboxPayloads from "./109_remove_legacy_workspace_patch_outbox_payloads.ts";
import * as userDirectedIssueSessions from "./110_user_directed_issue_sessions.ts";
import * as workspaceGitOauthRequests from "./111_workspace_git_oauth_requests.ts";
import * as liveWorkspaceSettlement from "./112_live_workspace_settlement.ts";
import * as workspaceOwnedToolRuntime from "./113_workspace_owned_tool_runtime.ts";

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return {
      "001_initial_control_plane": initialControlPlane,
      "002_durable_event_delivery": durableEventDelivery,
      "003_explicit_session_mailbox": explicitSessionMailbox,
      "004_supervisor_connection_health": supervisorConnectionHealth,
      "005_supervisor_boot_credentials": supervisorBootCredentials,
      "006_private_multi_tenant_identity": privateMultiTenantIdentity,
      "007_encrypted_tenant_model_credentials": encryptedTenantModelCredentials,
      "008_controlled_workspace_sources": controlledWorkspaceSources,
      "009_durable_runs_and_attempts": durableRunsAndAttempts,
      "010_versioned_workspaces_and_github_delivery": versionedWorkspacesAndGitHubDelivery,
      "011_context_and_model_governance": contextAndModelGovernance,
      "012_observability_trace_identity": observabilityTraceIdentity,
      "013_product_auth_and_empty_workspaces": productAuthAndEmptyWorkspaces,
      "014_remove_per_run_token_budget": removePerRunTokenBudget,
      "015_versioned_project_environments": versionedProjectEnvironments,
      "016_environment_recipes_and_operations": environmentRecipesAndOperations,
      "017_multi_repository_source_sets": multiRepositorySourceSets,
      "018_attempt_rewinds_and_review_bundles": attemptRewindsAndReviewBundles,
      "019_legacy_environment_validation_evidence": legacyEnvironmentValidationEvidence,
      "020_semantic_conversation_projections": semanticConversationProjections,
      "021_parallel_candidate_races": parallelCandidateRaces,
      "022_horizontal_supervisor_pool": horizontalSupervisorPool,
      "023_temporal_worker_affinity": temporalWorkerAffinity,
      "024_hot_platform_runtime_settings": hotPlatformRuntimeSettings,
      "025_large_workspace_checkpoints": largeWorkspaceCheckpoints,
      "026_workspace_first_conversations": workspaceFirstConversations,
      "027_shared_workspace_heads": sharedWorkspaceHeads,
      "028_interrupted_pi_conversations": interruptedPiConversations,
      "029_external_platform_git_metadata": externalPlatformGitMetadata,
      "030_active_pi_steer": activePiSteer,
      "031_typed_tool_outcomes": typedToolOutcomes,
      "032_model_sampling_step_identity": modelSamplingStepIdentity,
      "033_enterprise_execution_cells": enterpriseExecutionCells,
      "034_sandbox_manager_ownership": sandboxManagerOwnership,
      "035_partitioned_session_event_log": partitionedSessionEventLog,
      "036_faster_event_identity_registration": fasterEventIdentityRegistration,
      "037_execution_cell_worker_routes": executionCellWorkerRoutes,
      "038_workspace_cell_migrations": workspaceCellMigrations,
      "039_external_worker_event_log": externalWorkerEventLog,
      "040_session_sandbox_retention": sessionSandboxRetention,
      "041_decouple_persistent_sandbox_leases": decouplePersistentSandboxLeases,
      "042_kafka_first_worker_event_log": kafkaFirstWorkerEventLog,
      "043_session_event_hot_retention": sessionEventHotRetention,
      "044_canonical_conversations_and_live_streams": canonicalConversationsAndLiveStreams,
      "045_sandbox_domains_and_tool_broker": sandboxDomainsAndToolBroker,
      "046_temporal_outbox_handoff": temporalOutboxHandoff,
      "047_remove_temporal_worker_affinity": removeTemporalWorkerAffinity,
      "048_turn_admission_index": turnAdmissionIndex,
      "049_tenant_sandbox_quota": tenantSandboxQuota,
      "050_primary_tool_broker_route": primaryToolBrokerRoute,
      "051_bootstrap_tenant_sandbox_quota": bootstrapTenantSandboxQuota,
      "052_postgres_run_queue": postgresRunQueue,
      "053_pi_session_storage": piSessionStorage,
      "054_postgres_checkpoint_objects": postgresCheckpointObjects,
      "055_unlimited_default_daily_tokens": unlimitedDefaultDailyTokens,
      "056_coding_run_model_request_limit": codingRunModelRequestLimit,
      "057_conversation_tree_forks": conversationTreeForks,
      "058_workspace_deletion": workspaceDeletion,
      "059_pi_session_opaque_identifiers": piSessionOpaqueIdentifiers,
      "060_workspace_terminal_leases": workspaceTerminalLeases,
      "061_remove_dormant_advanced_features": removeDormantAdvancedFeatures,
      "062_postgres_session_storage_only": postgresSessionStorageOnly,
      "063_pi_cloud_environment_profile": piCloudEnvironmentProfile,
      "064_pi_cloud_run_queue_notification": piCloudRunQueueNotification,
      "065_run_tool_capability_snapshots": runToolCapabilitySnapshots,
      "066_durable_subagent_executions": durableSubagentExecutions,
      "067_toolless_run_capabilities": toollessRunCapabilities,
      "068_subagent_run_system_prompt": subagentRunSystemPrompt,
      "069_isolated_subagent_workspaces": isolatedSubagentWorkspaces,
      "070_conversation_tail_pruning": conversationTailPruning,
      "071_subagent_supervisor_channel": subagentSupervisorChannel,
      "072_shared_pi_session_entries": sharedPiSessionEntries,
      "073_recursive_subagent_trees": recursiveSubagentTrees,
      "074_user_owned_development_environments": userOwnedDevelopmentEnvironments,
      "075_canonical_pi_conversation_entries": canonicalPiConversationEntries,
      "076_postgres_live_event_authority": postgresLiveEventAuthority,
      "077_remove_legacy_event_id_trigger": removeLegacyEventIdTrigger,
      "078_kafka_first_agent_event_log": kafkaFirstAgentEventLog,
      "079_remove_postgres_hot_event_log": removePostgresHotEventLog,
      "080_reconcile_coding_model_limits": reconcileCodingModelLimits,
      "081_development_environment_profiles": developmentEnvironmentProfiles,
      "082_workspace_terminal_fencing": workspaceTerminalFencing,
      "083_remove_duplicate_compaction_ledger": removeDuplicateCompactionLedger,
      "084_conversation_workspace_rebinding": conversationWorkspaceRebinding,
      "085_ssh_access_tickets": sshAccessTickets,
      "086_session_execution_profiles": sessionExecutionProfiles,
      "087_development_environment_machine_identity": developmentEnvironmentMachineIdentity,
      "088_exclusive_vm_state": exclusiveVmState,
      "089_exclusive_machine_working_directories": exclusiveMachineWorkingDirectories,
      "090_development_environment_recovery_identity": developmentEnvironmentRecoveryIdentity,
      "091_execution_grants": executionGrants,
      "092_sandbox_http_services": sandboxHttpServices,
      "093_machine_owned_workspaces": machineOwnedWorkspaces,
      "094_agent_event_writer_channels": agentEventWriterChannels,
      "095_fact_channels": factChannels,
      "096_session_kafka_heads": sessionKafkaHeads,
      "097_session_lease_fencing": sessionLeaseFencing,
      "098_remove_repository_import": removeRepositoryImport,
      "099_remove_dormant_approval_graph": removeDormantApprovalGraph,
      "100_remove_legacy_database_functions": removeLegacyDatabaseFunctions,
      "101_user_managed_workspace_concurrency": userManagedWorkspaceConcurrency,
      "102_workspace_tool_runtime_slot": workspaceToolRuntimeSlot,
      "103_run_queue_authority": runQueueAuthority,
      "104_source_control_app_and_issue_jobs": sourceControlAppAndIssueJobs,
      "105_versioned_agent_definitions": versionedAgentDefinitions,
      "106_gitlab_project_connections": gitlabProjectConnections,
      "107_oidc_identity_and_issue_claims": oidcIdentityAndIssueClaims,
      "108_remove_platform_git_change_tracking": removePlatformGitChangeTracking,
      "109_remove_legacy_workspace_patch_outbox_payloads": removeLegacyWorkspacePatchOutboxPayloads,
      "110_user_directed_issue_sessions": userDirectedIssueSessions,
      "111_workspace_git_oauth_requests": workspaceGitOauthRequests,
      "112_live_workspace_settlement": liveWorkspaceSettlement,
      "113_workspace_owned_tool_runtime": workspaceOwnedToolRuntime,
    };
  },
};
