import type { WalletProfile, WalletKeyRecord } from "../config/profile.js";

export type CapabilityIssueCode =
  | "no_wallet_profile"
  | "no_keys"
  | "no_active_key"
  | "active_key_expired"
  | "active_key_revoked"
  | "local_key_missing"
  | "requested_key_not_found"
  | "requested_key_unusable"
  | "missing_call_permission"
  | "missing_spend_permission";

export type PermissionDelta = {
  missingCalls?: Array<{ to: `0x${string}`; signature: string }>;
  missingSpend?: Array<{ token: `0x${string}`; suggestedLimit: string; suggestedPeriod: string }>;
  suggestedCommand?: string;
};

export type CapabilityIssue = {
  code: CapabilityIssueCode;
  message: string;
  suggestedAction?: string;
  delta?: PermissionDelta;
};

export type CapabilitySummary = {
  readiness: "ready" | "needs_key";
  issues: CapabilityIssue[];
};

export function evaluateDelegatedKeyCapability(options: {
  profile: WalletProfile;
  activeKey: WalletKeyRecord | undefined;
  now?: Date;
}): CapabilitySummary {
  const nowMs = (options.now ?? new Date()).getTime();
  const issues: CapabilityIssue[] = [];

  if (options.profile.keys.length === 0) {
    issues.push({
      code: "no_keys",
      message: "No delegated keys exist yet.",
      suggestedAction: "Run `mega moss create-key` to authorize a delegated key.",
    });
    return { readiness: "needs_key", issues };
  }

  if (options.activeKey === undefined) {
    issues.push({
      code: "no_active_key",
      message: "No usable default delegated key is selected.",
      suggestedAction:
        "Run `mega moss list --show-inactive`, then `mega moss switch <key>` or `mega moss create-key`.",
    });
    return { readiness: "needs_key", issues };
  }

  if (options.activeKey.status === "revoked") {
    issues.push({
      code: "active_key_revoked",
      message: "The active delegated key has been revoked.",
      suggestedAction: "Create a new delegated key with `mega moss create-key`.",
    });
  }

  if (options.activeKey.authorizedKey.expiry * 1000 <= nowMs) {
    issues.push({
      code: "active_key_expired",
      message: "The active delegated key is expired.",
      suggestedAction: "Create a new delegated key with `mega moss create-key`.",
    });
  }

  if (options.activeKey.privateKey === undefined) {
    issues.push({
      code: "local_key_missing",
      message: "Local delegated key material is missing for the active key.",
      suggestedAction:
        "Switch to a different active key or create a new delegated key on this machine.",
    });
  }

  return {
    readiness: issues.length === 0 ? "ready" : "needs_key",
    issues,
  };
}


export function evaluateTransferAuthority(options: {
  key: WalletKeyRecord | undefined;
  token?: `0x${string}`;
  requestedKey?: string;
  profile: WalletProfile;
}): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const key = options.key;

  if (options.requestedKey !== undefined && key === undefined) {
    issues.push({
      code: "requested_key_not_found",
      message: `Requested delegated key not found: ${options.requestedKey}.`,
      suggestedAction: "Run `mega moss list --show-inactive` to inspect available keys.",
    });
    return issues;
  }

  if (key === undefined) {
    return issues;
  }

  if (key.privateKey === undefined) {
    issues.push({
      code: "requested_key_unusable",
      message: "The selected delegated key has no local private key material on this machine.",
      suggestedAction: "Switch to a local key or create a new delegated key on this machine.",
    });
  }

  if (options.token !== undefined) {
    const hasCall = (key.authorizedKey.permissions.calls ?? []).some(
      (call) =>
        call.to?.toLowerCase() === options.token?.toLowerCase() &&
        call.signature === "transfer(address,uint256)",
    );
    if (!hasCall) {
      issues.push({
        code: "missing_call_permission",
        message: `The selected delegated key does not include transfer(address,uint256) call permission for ${options.token}.`,
        suggestedAction: `Create a key with --allow-call '${options.token}:transfer(address,uint256)'`,
        delta: {
          missingCalls: [{ to: options.token, signature: "transfer(address,uint256)" }],
          suggestedCommand: `mega moss create-key --allow-call '${options.token}:transfer(address,uint256)'`,
        },
      });
    }

    const hasSpend = key.authorizedKey.permissions.spend.some(
      (spend) => spend.token?.toLowerCase() === options.token?.toLowerCase(),
    );
    if (!hasSpend) {
      issues.push({
        code: "missing_spend_permission",
        message: `The selected delegated key does not include spend permission for ${options.token}.`,
        suggestedAction: `Create a key with --spend-limit ${options.token}:<amount>:<period>`,
        delta: {
          missingSpend: [{ token: options.token, suggestedLimit: "<amount>", suggestedPeriod: "week" }],
          suggestedCommand: `mega moss create-key --spend-limit ${options.token}:<amount>:week`,
        },
      });
    }
  }

  return issues;
}


export function evaluateExecuteAuthority(options: {
  calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>;
  key: WalletKeyRecord | undefined;
  requestedKey?: string;
  profile: WalletProfile;
}): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const key = options.key;

  if (options.requestedKey !== undefined && key === undefined) {
    issues.push({
      code: "requested_key_not_found",
      message: `Requested delegated key not found: ${options.requestedKey}.`,
      suggestedAction: "Run `mega moss list --show-inactive` to inspect available keys.",
    });
    return issues;
  }

  if (key === undefined) {
    return issues;
  }

  if (key.privateKey === undefined) {
    issues.push({
      code: "requested_key_unusable",
      message: "The selected delegated key has no local private key material on this machine.",
      suggestedAction: "Switch to a local key or create a new delegated key on this machine.",
    });
  }

  const missingCalls: Array<{ to: `0x${string}`; signature: string }> = [];
  const missingSpend: Array<{ token: `0x${string}`; suggestedLimit: string; suggestedPeriod: string }> = [];

  for (const call of options.calls) {
    const selector = call.data.length >= 10 ? `selector:${call.data.slice(0, 10)}` : "selector:0x";
    const hasCall = (key.authorizedKey.permissions.calls ?? []).some(
      (perm) => perm.to?.toLowerCase() === call.to.toLowerCase(),
    );
    if (!hasCall && !missingCalls.some((entry) => entry.to.toLowerCase() === call.to.toLowerCase())) {
      missingCalls.push({ to: call.to, signature: selector });
    }

    if (call.value !== "0") {
      missingSpend.push({
        token: "0x0000000000000000000000000000000000000000",
        suggestedLimit: call.value,
        suggestedPeriod: "week",
      });
    }
  }

  if (missingCalls.length > 0) {
    issues.push({
      code: "missing_call_permission",
      message: "The selected delegated key is missing one or more call permissions required by the requested execution plan.",
      suggestedAction: "Create or switch to a delegated key with the required call permissions.",
      delta: {
        missingCalls,
        suggestedCommand: "mega moss create-key --allow-call '<contract>:<functionSignature>'",
      },
    });
  }

  if (missingSpend.length > 0) {
    issues.push({
      code: "missing_spend_permission",
      message: "The selected delegated key may require additional spend authority for calls that transfer native value.",
      suggestedAction: "Create or switch to a delegated key with sufficient spend allowance.",
      delta: {
        missingSpend,
        suggestedCommand: "mega moss create-key --spend-limit 0x0000000000000000000000000000000000000000:<amount>:week",
      },
    });
  }

  return issues;
}
