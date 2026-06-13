import type { CapabilityIssue } from "./capability.js";

export type DelegatedKeySummary = {
  id: `0x${string}`;
  accessAddress: `0x${string}`;
  expiry: number;
};

export type Readiness = "ready" | "needs_key";

export type PreviewEnvelope = {
  readiness: Readiness;
  activeKey?: DelegatedKeySummary;
  requestedKey?: string;
  issues: CapabilityIssue[];
  warnings: string[];
};
