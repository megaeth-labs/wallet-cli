import type { WalletProfile, WalletKeyRecord } from "../config/profile.js";

export type CapabilityIssueCode =
  | "no_keys"
  | "no_active_key"
  | "active_key_expired"
  | "active_key_revoked"
  | "local_key_missing"
  | "requested_key_not_found"
  | "requested_key_unusable"
  | "missing_call_permission"
  | "missing_spend_permission";

export type CapabilityIssue = {
  code: CapabilityIssueCode;
  message: string;
  suggestedAction?: string;
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
      });
    }
  }

  return issues;
}
