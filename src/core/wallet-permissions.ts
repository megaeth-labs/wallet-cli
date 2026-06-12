import { normalizeNetwork } from "../commands/common.js";
import type { StatusCommandOptions, WalletCommandDependencies, WalletPermissionsResult } from "../commands/wallet.js";
import { summarizeAuthorizedKey } from "../config/permissionSummary.js";
import { findWalletKey, readWalletProfile, type WalletKeyRecord } from "../config/profile.js";
import { CliError } from "../errors.js";
import { readSpendInfos, type DelegatedSpendInfo } from "../relay/spendInfo.js";
import { loadTokenMetadataForStatus, renderableKey } from "./wallet-status.js";
import type { Network } from "../config/chains.js";

export async function getWalletPermissions(
  selector: string,
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletPermissionsResult> {
  const network = normalizeNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const key = requireWalletKey(profile.keys, selector);
  const renderedKey = renderableKey(profile, key, getNow(dependencies));
  const spendInfoResult = options.terse
    ? {}
    : await loadSpendInfosForPermissions(profile.accountAddress, key, network, dependencies);
  const tokenMetadata = options.terse
    ? {}
    : await loadTokenMetadataForStatus(
        [key],
        spendInfoResult.spendInfos,
        network,
        dependencies,
      );

  return {
    accountAddress: profile.accountAddress,
    key: renderedKey,
    network,
    permissionLines: summarizeAuthorizedKey(key.authorizedKey, tokenMetadata).lines,
    ...spendInfoResult,
    ...(Object.keys(tokenMetadata).length === 0 ? {} : { tokenMetadata }),
  };
}

async function loadSpendInfosForPermissions(
  accountAddress: `0x${string}`,
  key: WalletKeyRecord,
  network: Network,
  dependencies: WalletCommandDependencies,
): Promise<Pick<WalletPermissionsResult, "spendInfoError" | "spendInfos">> {
  try {
    const spendInfos = await (dependencies.readSpendInfos ?? readSpendInfos)({
      accountAddress,
      key,
      network,
    });
    return { spendInfos };
  } catch (error) {
    return { spendInfoError: formatSpendInfoError(error) };
  }
}

function requireWalletKey(keys: readonly WalletKeyRecord[], selector: string): WalletKeyRecord {
  const key = keys.find(
    (entry) =>
      entry.id.toLowerCase() === selector.toLowerCase() ||
      entry.accessAddress.toLowerCase() === selector.toLowerCase() ||
      entry.label?.toLowerCase() === selector.toLowerCase(),
  );
  if (key === undefined) {
    throw new CliError(`delegated key not found: ${selector}`);
  }

  return key;
}

function formatSpendInfoError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split("\n", 1)[0] ?? error.message;
  }

  return "unknown error";
}

function getNow(dependencies: WalletCommandDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}
