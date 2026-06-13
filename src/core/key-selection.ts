import { getActiveWalletKey, type WalletProfile } from "../config/profile.js";
import { evaluateDelegatedKeyCapability, type CapabilityIssue } from "./capability.js";
import type { DelegatedKeySummary, PreviewEnvelope } from "./runtime-types.js";

export function resolveSelectedKey(profile: WalletProfile, selector?: string) {
  if (selector === undefined) {
    return getActiveWalletKey(profile);
  }

  return profile.keys.find(
    (key) =>
      key.id.toLowerCase() === selector.toLowerCase() ||
      key.accessAddress.toLowerCase() === selector.toLowerCase() ||
      key.label?.toLowerCase() === selector.toLowerCase(),
  );
}

export function summarizeSelectedKey(options: {
  profile: WalletProfile;
  requestedKey?: string;
  selectedKey: ReturnType<typeof resolveSelectedKey>;
  extraIssues?: CapabilityIssue[];
}): PreviewEnvelope {
  const baseCapability = evaluateDelegatedKeyCapability({
    profile: options.profile,
    activeKey: options.selectedKey,
  });
  const issues = [...baseCapability.issues, ...(options.extraIssues ?? [])];

  return {
    readiness: issues.length === 0 ? "ready" : "needs_key",
    ...(options.selectedKey === undefined
      ? {}
      : { activeKey: toDelegatedKeySummary(options.selectedKey) }),
    ...(options.requestedKey === undefined ? {} : { requestedKey: options.requestedKey }),
    issues,
    warnings: issues.map((issue) => issue.message),
  };
}

export function toDelegatedKeySummary(key: NonNullable<ReturnType<typeof resolveSelectedKey>>): DelegatedKeySummary {
  return {
    id: key.id,
    accessAddress: key.accessAddress,
    expiry: key.authorizedKey.expiry,
  };
}
