import { normalizeNetwork } from "../commands/common.js";
import type { ExecuteCallInput } from "../commands/execute.js";
import type { WalletCommandDependencies } from "../commands/wallet.js";
import { readWalletProfile } from "../config/profile.js";
import { evaluateExecuteAuthority, type CapabilityIssue } from "./capability.js";
import { resolveSelectedKey, summarizeSelectedKey } from "./key-selection.js";
import type { PreviewEnvelope } from "./runtime-types.js";
import { normalizeExecuteCalls } from "./execute-shared.js";

export type ExecutePreviewInput = {
  calls: readonly ExecuteCallInput[];
  key?: string;
  network?: string;
};

export type ExecutePreviewResult = {
  network: "mainnet" | "testnet";
  accountAddress: `0x${string}`;
  readiness: "ready" | "needs_key";
  calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>;
  issues: CapabilityIssue[];
  warnings: string[];
} & PreviewEnvelope;

export async function previewExecute(
  input: ExecutePreviewInput,
  dependencies: WalletCommandDependencies = {},
): Promise<ExecutePreviewResult> {
  const network = normalizeNetwork(input.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const activeKey = resolveSelectedKey(profile, input.key);
  const calls = normalizeExecuteCalls(input.calls).map((call) => ({
    ...call,
    value: call.value.toString(),
  }));
  const executeIssues = evaluateExecuteAuthority({
    calls,
    key: activeKey,
    ...(input.key === undefined ? {} : { requestedKey: input.key }),
    profile,
  });
  const envelope = summarizeSelectedKey({
    profile,
    requestedKey: input.key,
    selectedKey: activeKey,
    extraIssues: executeIssues,
  });

  return {
    network,
    accountAddress: profile.accountAddress,
    ...envelope,
    calls,
    issues: envelope.issues,
    warnings: envelope.warnings,
  };
}
