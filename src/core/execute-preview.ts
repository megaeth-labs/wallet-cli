import { normalizeNetwork } from "../commands/common.js";
import type { ExecuteCallInput } from "../commands/execute.js";
import type { WalletCommandDependencies } from "../commands/wallet.js";
import { getActiveWalletKey, readWalletProfile } from "../config/profile.js";
import { evaluateDelegatedKeyCapability, type CapabilityIssue } from "./capability.js";
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
  activeKey?: {
    id: `0x${string}`;
    accessAddress: `0x${string}`;
    expiry: number;
  };
  requestedKey?: string;
  calls: Array<{ to: `0x${string}`; data: `0x${string}`; value: string }>;
  issues: CapabilityIssue[];
  warnings: string[];
};

export async function previewExecute(
  input: ExecutePreviewInput,
  dependencies: WalletCommandDependencies = {},
): Promise<ExecutePreviewResult> {
  const network = normalizeNetwork(input.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const activeKey = selectKey(profile, input.key);
  const calls = normalizeExecuteCalls(input.calls).map((call) => ({
    ...call,
    value: call.value.toString(),
  }));
  const capability = evaluateDelegatedKeyCapability({ profile, activeKey });

  return {
    network,
    accountAddress: profile.accountAddress,
    readiness: capability.readiness,
    ...(activeKey === undefined
      ? {}
      : {
          activeKey: {
            id: activeKey.id,
            accessAddress: activeKey.accessAddress,
            expiry: activeKey.authorizedKey.expiry,
          },
        }),
    ...(input.key === undefined ? {} : { requestedKey: input.key }),
    calls,
    issues: capability.issues,
    warnings: capability.issues.map((issue) => issue.message),
  };
}

function selectKey(profile: Awaited<ReturnType<typeof readWalletProfile>>, selector: string | undefined) {
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
