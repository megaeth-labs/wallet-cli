import { normalizeNetwork } from "../commands/common.js";
import type { DebugCommandDependencies, DebugCommandOptions, DebugCommandResult } from "../commands/debug.js";
import { getChainConfig, type Network } from "../config/chains.js";
import { getProfilePath } from "../config/paths.js";
import {
  getActiveWalletKey,
  getProfileMode,
  readWalletProfile,
  type HexString,
  type WalletKeyRecord,
  type WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  createEthReadClient,
  getDefaultRpcUrl,
  normalizeRpcUrl,
  type EthReadClient,
} from "../eth/client.js";
import { redactString } from "../output.js";
import {
  createPortoRelayClient,
  portoRelayActions,
  relayErrorToCliError,
  resolvePortoRelayUrl,
  type PortoRelayActions,
  type PortoRelayClient,
  type RelayAccountKey,
} from "../relay/sendCalls.js";
import { sessionKeyFromWalletKey } from "../relay/sessionKey.js";

export async function getWalletDebug(
  options: DebugCommandOptions,
  dependencies: DebugCommandDependencies = {},
): Promise<DebugCommandResult> {
  const network = normalizeNetwork(options.network);
  const env = dependencies.env ?? process.env;
  const profile = await readWalletProfile(network, env);
  const activeKey = getActiveWalletKey(profile);
  if (activeKey === undefined) {
    throw new CliError(
      profile.keys.length === 0
        ? "wallet profile has no delegated keys; run mega moss create-key"
        : "wallet profile has no usable default delegated key; run mega moss list --show-inactive, then mega moss switch <key> or mega moss create-key",
    );
  }
  const rpcUrl = normalizeRpcUrl(options.rpcUrl ?? getDefaultRpcUrl(network));
  const result: DebugCommandResult = {
    accessAddress: activeKey.accessAddress,
    accountAddress: profile.accountAddress,
    createdAt: profile.createdAt,
    delegatedKey: await inspectDelegatedKey(profile, activeKey, {
      createRelayClient: dependencies.createRelayClient,
      now: dependencies.now,
      relayActions: dependencies.relayActions,
      skipChain: options.skipChain,
    }),
    nativeBalance: await inspectNativeBalance(profile.accountAddress, {
      createReadClient: dependencies.createReadClient,
      network,
      rpcUrl,
      skipChain: options.skipChain,
    }),
    network,
    permissions: activeKey.authorizedKey.permissions,
    profilePath: getProfilePath(network, env),
    relayUrl: profile.relayUrl,
    rpcUrl,
    updatedAt: profile.updatedAt,
    walletUrl: profile.walletUrl,
    ...(activeKey.grantTxHash === undefined ? {} : { grantTxHash: activeKey.grantTxHash }),
  };

  const mode = await readProfileMode(network, env);
  if (mode !== undefined) {
    result.profileMode = mode;
  }

  return result;
}

async function inspectDelegatedKey(
  profile: WalletProfile,
  activeKey: WalletKeyRecord,
  options: {
    createRelayClient?: (relayUrl: string, network: Network) => PortoRelayClient;
    now?: () => Date;
    relayActions?: PortoRelayActions;
    skipChain?: boolean;
  },
): Promise<DebugCommandResult["delegatedKey"]> {
  const nowSeconds = Math.floor((options.now ?? (() => new Date()))().getTime() / 1000);
  let localStatus: DebugCommandResult["delegatedKey"]["localStatus"] =
    activeKey.authorizedKey.expiry <= nowSeconds ? "expired" : "active";
  try {
    sessionKeyFromWalletKey(activeKey);
  } catch {
    localStatus = "invalid";
  }

  const base = {
    chainStatus: options.skipChain ? "skipped" : "unavailable",
    expiresAt: new Date(activeKey.authorizedKey.expiry * 1000).toISOString(),
    localStatus,
  } satisfies DebugCommandResult["delegatedKey"];

  if (options.skipChain) {
    return base;
  }

  const actions = options.relayActions ?? portoRelayActions;
  if (!actions.getKeys) {
    return { ...base, chainError: "relay getKeys is not available", chainStatus: "unavailable" };
  }

  try {
    const relayUrl = resolvePortoRelayUrl(profile.relayUrl, profile.network);
    const client = options.createRelayClient?.(relayUrl, profile.network) ?? createPortoRelayClient(relayUrl, profile.network);
    const keys = await actions.getKeys(client, {
      account: profile.accountAddress,
      chainIds: [getChainConfig(profile.network).chainId],
    });
    const chainKey = keys.find((key) => keyMatchesProfile(key, activeKey));
    if (!chainKey) {
      return { ...base, chainStatus: "missing" };
    }
    return { ...base, chainKey: summarizeChainKey(chainKey), chainStatus: "authorized" };
  } catch (error) {
    const mapped = relayErrorToCliError(error);
    return { ...base, chainError: firstLine(mapped.message), chainStatus: "unavailable" };
  }
}

async function inspectNativeBalance(
  accountAddress: HexString,
  options: {
    createReadClient?: (network: Network, rpcUrl: string) => EthReadClient;
    network: Network;
    rpcUrl: string;
    skipChain?: boolean;
  },
): Promise<DebugCommandResult["nativeBalance"]> {
  if (options.skipChain) {
    return { status: "skipped" };
  }

  try {
    const client = options.createReadClient?.(options.network, options.rpcUrl) ?? createEthReadClient(options.network, options.rpcUrl);
    const wei = await client.getBalance(accountAddress);
    return { status: "available", symbol: "ETH", wei: wei.toString() };
  } catch (error) {
    return {
      error: error instanceof Error && error.message.length > 0 ? firstLine(redactString(error.message)) : undefined,
      status: "unavailable",
    };
  }
}

async function readProfileMode(network: Network, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return `0${(await getProfileMode(network, env)).toString(8)}`;
  } catch {
    return undefined;
  }
}

function keyMatchesProfile(key: RelayAccountKey, activeKey: WalletKeyRecord): boolean {
  return (
    matchesHex(key.id, activeKey.accessAddress) ||
    matchesHex(key.publicKey, activeKey.accessAddress) ||
    matchesHex(key.hash, activeKey.accessAddress)
  );
}

function summarizeChainKey(key: RelayAccountKey): NonNullable<DebugCommandResult["delegatedKey"]["chainKey"]> {
  return {
    ...(typeof key.expiry === "number" ? { expiry: key.expiry } : {}),
    ...(isHexString(key.id) ? { id: key.id } : {}),
    ...(isHexString(key.publicKey) ? { publicKey: key.publicKey } : {}),
    ...(typeof key.role === "string" ? { role: key.role } : {}),
  };
}

function matchesHex(value: unknown, expected: HexString): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function isHexString(value: unknown): value is HexString {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value);
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}
