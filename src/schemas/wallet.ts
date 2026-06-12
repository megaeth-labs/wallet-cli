import type { OperationSchema } from "../core/operations.js";

export const whoamiSchema: OperationSchema = {
  id: "moss_whoami",
  title: "Wallet identity and active delegated key",
  description: "Return the connected account profile and currently selected delegated key.",
  safety: "read",
  exposedIn: { cli: true, mcp: true },
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
  input: {
    type: "object",
    properties: {
      network: { type: "string", enum: ["mainnet", "testnet"] },
    },
    additionalProperties: false,
  },
  output: { type: "object", description: "Wallet debug diagnostics." },
};
