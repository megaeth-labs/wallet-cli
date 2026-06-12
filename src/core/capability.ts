import type { WalletProfile, WalletKeyRecord } from "../config/profile.js";

export type CapabilityIssueCode =
  | "no_keys"
  | "no_active_key"
  | "active_key_expired"
  | "active_key_revoked"
  | "local_key_missing";

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
