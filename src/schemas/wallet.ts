import type { OperationSchema } from "../core/operations.js";

export const whoamiSchema: OperationSchema = {
  id: "moss_whoami",
  title: "Wallet identity and active delegated key",
  description: "Return the connected account profile and currently selected delegated key.",
  safety: "read",
  exposedIn: { cli: true, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    movesValue: false,
    requirements: { requiresWalletProfile: true },
    role: "read",
    valueType: "none",
  },
  input: {
    type: "object",
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    additionalProperties: false,
  },
  output: {
    type: "object",
    description: "Wallet status summary including account and active key details.",
  },
};

export const listSchema: OperationSchema = {
  id: "moss_list_keys",
  title: "List delegated keys",
  description: "List delegated keys known to the local wallet profile.",
  safety: "read",
  exposedIn: { cli: true, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    movesValue: false,
    requirements: { requiresWalletProfile: true },
    role: "read",
    valueType: "none",
  },
  input: {
    type: "object",
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
      showInactive: { type: "boolean" },
    },
    additionalProperties: false,
  },
  output: { type: "object", description: "Delegated key list result." },
};

export const permissionsSchema: OperationSchema = {
  id: "moss_permissions",
  title: "Inspect delegated key permissions",
  description: "Return the approved scope and spend info for a delegated key.",
  safety: "read",
  exposedIn: { cli: true, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    movesValue: false,
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true },
    role: "read",
    valueType: "none",
  },
  input: {
    type: "object",
    properties: {
      key: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    required: ["key"],
    additionalProperties: false,
  },
  output: { type: "object", description: "Permissions inspection result." },
};

export const debugSchema: OperationSchema = {
  id: "moss_debug",
  title: "Wallet debug diagnostics",
  description: "Inspect profile health, relay state, and delegated key diagnostics.",
  safety: "read",
  exposedIn: { cli: true, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    movesValue: false,
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true },
    role: "read",
    valueType: "none",
  },
  input: {
    type: "object",
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    additionalProperties: false,
  },
  output: { type: "object", description: "Wallet debug diagnostics." },
};

export const walletStatusSchema: OperationSchema = {
  id: "moss_wallet_status",
  title: "Aggregate wallet status",
  description: "Return the connected account, delegated key state, and whether the wallet is ready for delegated operations.",
  safety: "read",
  exposedIn: { cli: false, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    mayReturnIssues: ["no_keys", "no_active_key", "active_key_expired", "active_key_revoked", "local_key_missing"],
    movesValue: false,
    requirements: { requiresWalletProfile: true },
    role: "read",
    valueType: "none",
  },
  input: {
    type: "object",
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    additionalProperties: false,
  },
  output: { type: "object", description: "Aggregate wallet readiness and capability summary." },
};


export const transferPreviewSchema: OperationSchema = {
  id: "moss_transfer_preview",
  title: "Preview a wallet transfer",
  description: "Build and inspect a transfer plan without executing it.",
  safety: "preview-write",
  exposedIn: { cli: false, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    mayReturnIssues: ["no_keys", "no_active_key", "active_key_expired", "active_key_revoked", "local_key_missing", "requested_key_not_found", "requested_key_unusable", "missing_call_permission", "missing_spend_permission"],
    movesValue: true,
    pairsWith: "moss_transfer_execute",
    recommendedFirstStep: "moss_wallet_status",
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true, requiresSpendAuthority: true, canMoveValue: true },
    role: "preview",
    valueType: "native|erc20",
  },
  input: {
    type: "object",
    properties: {
      amount: { type: "string" },
      decimals: { type: "number" },
      key: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      rpcUrl: { type: "string" },
      to: { type: "string" },
      token: { type: "string" },
    },
    required: ["to", "amount"],
    additionalProperties: false,
  },
  output: { type: "object", description: "Transfer execution preview." },
};


export const transferExecuteSchema: OperationSchema = {
  id: "moss_transfer_execute",
  title: "Execute a wallet transfer",
  description: "Execute a transfer through the delegated-key relay path.",
  safety: "write",
  exposedIn: { cli: false, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    mayReturnIssues: ["no_keys", "no_active_key", "active_key_expired", "active_key_revoked", "local_key_missing", "requested_key_not_found", "requested_key_unusable", "missing_call_permission", "missing_spend_permission"],
    movesValue: true,
    pairsWith: "moss_transfer_preview",
    recommendedFirstStep: "moss_transfer_preview",
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true, requiresSpendAuthority: true, canMoveValue: true },
    role: "execute",
    valueType: "native|erc20",
  },
  input: {
    type: "object",
    properties: {
      amount: { type: "string" },
      decimals: { type: "number" },
      key: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
      rpcUrl: { type: "string" },
      to: { type: "string" },
      token: { type: "string" },
    },
    required: ["to", "amount"],
    additionalProperties: false,
  },
  output: { type: "object", description: "Transfer execution result." },
};


export const executePreviewSchema: OperationSchema = {
  id: "moss_execute_preview",
  title: "Preview arbitrary relay-backed calls",
  description: "Normalize one or more calls and inspect delegated-key readiness without executing.",
  safety: "preview-write",
  exposedIn: { cli: false, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    mayReturnIssues: ["no_keys", "no_active_key", "active_key_expired", "active_key_revoked", "local_key_missing", "requested_key_not_found", "requested_key_unusable", "missing_call_permission", "missing_spend_permission"],
    movesValue: true,
    pairsWith: "moss_execute",
    recommendedFirstStep: "moss_wallet_status",
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true, requiresCallAuthority: true, canMoveValue: true },
    role: "preview",
    valueType: "arbitrary",
  },
  input: {
    type: "object",
    properties: {
      calls: { type: "array" },
      key: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    required: ["calls"],
    additionalProperties: false,
  },
  output: { type: "object", description: "Execute preview result." },
};


export const executeSchema: OperationSchema = {
  id: "moss_execute",
  title: "Execute arbitrary relay-backed calls",
  description: "Execute one or more calls using existing delegated authority.",
  safety: "write",
  exposedIn: { cli: false, mcp: true },
  metadata: {
    agentExposed: true,
    humanGoverned: false,
    mayReturnIssues: ["no_keys", "no_active_key", "active_key_expired", "active_key_revoked", "local_key_missing", "requested_key_not_found", "requested_key_unusable", "missing_call_permission", "missing_spend_permission"],
    movesValue: true,
    pairsWith: "moss_execute_preview",
    recommendedFirstStep: "moss_execute_preview",
    requirements: { requiresWalletProfile: true, requiresDelegatedKey: true, requiresCallAuthority: true, canMoveValue: true },
    role: "execute",
    valueType: "arbitrary",
  },
  input: {
    type: "object",
    properties: {
      calls: { type: "array" },
      key: { type: "string" },
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    required: ["calls"],
    additionalProperties: false,
  },
  output: { type: "object", description: "Execute result." },
};
