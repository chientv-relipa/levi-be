// Shared SDK constants: payload limits, status enums, module names, deployed object IDs.

export const MAX_PAYLOAD = 8192;
export const MAX_ALLOWED_TARGETS = 10;

// ActionStatus (must match `levi::action` u8 codes).
export const actionStatus = {
  pending: 1,
  approved: 2,
  escalated: 3,
  blocked: 4,
  rejected: 5,
} as const;
export type ActionStatus = (typeof actionStatus)[keyof typeof actionStatus];

export const agentStatus = {
  inactive: 0,
  active: 1,
} as const;
export type AgentStatus = (typeof agentStatus)[keyof typeof agentStatus];

/** Move module names (one per instruction), used to build `pkg::module::fn` targets. */
export const MODULES = {
  initialize: "initialize",
  updateConfig: "update_config",
  updateMaintenance: "update_maintenance",
  registerAgent: "register_agent",
  activateAgent: "activate_agent",
  deactivateAgent: "deactivate_agent",
  updateAgentProgramTarget: "update_agent_program_target",
  submitAction: "submit_action",
  verdictAction: "verdict_action",
  approveAction: "approve_action",
  rejectAction: "reject_action",
  registry: "registry",
} as const;

/**
 * The on-chain object IDs created by the testnet bootstrap (see
 * `sui-contract/DEPLOYMENT.testnet.md`). Override via `LeviAddresses` for other
 * deployments.
 */
export const TESTNET_ADDRESSES = {
  packageId:
    "0x5a9e02eabf663e8495a4144e487a71a744c72e378bd9637412c3d45ce69241fb",
  configId:
    "0x6f329ff56cd8dad2611a26919872672478ddc6de65fca3a18ed1b3a13e9d995c",
  registryId:
    "0xd501e527ac538e43f6650c652842ef23ddd970a8c9cd48089b5285b8b9a80d53",
  adminCapId:
    "0xd845f5a94c2dc5c605918be3035ca614f7442c0dbf1459b7229c99fe5b87bb59",
  relayerCapId:
    "0x4ffe42c13d5ce2db81f0df42f1d43941d8463b10544cc479cc09146cf107e6f7",
} as const;

/** The package + shared object IDs an SDK caller needs to build PTBs. */
export interface LeviAddresses {
  packageId: string;
  configId: string;
  registryId: string;
}

export const testnetLeviAddresses = (): LeviAddresses => ({
  packageId: TESTNET_ADDRESSES.packageId,
  configId: TESTNET_ADDRESSES.configId,
  registryId: TESTNET_ADDRESSES.registryId,
});
