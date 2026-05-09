import { Command } from "commander";

import {
  defaultNetwork,
  getChainConfig,
  isNetwork,
  isSupportedNetwork,
  type Network,
  unsupportedNetworkMessage,
} from "../config/chains.js";
import { getProfilePath } from "../config/paths.js";
import {
  getProfileMode,
  readWalletProfile,
  type AuthorizedKey,
  type HexString,
  type WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  createEthReadClient,
  getDefaultRpcUrl,
  normalizeRpcUrl,
  type EthReadClient,
} from "../eth/client.js";
import { compactAddress, redactString, toJson } from "../output.js";
import {
  createPortoRelayClient,
  portoRelayActions,
  relayErrorToCliError,
  type PortoRelayActions,
  type PortoRelayClient,
  type RelayAccountKey,
} from "../relay/sendCalls.js";
import { sessionKeyFromProfile } from "../relay/sessionKey.js";

export type DebugCommandOptions = {
  json?: boolean;
  network?: string;
  rpcUrl?: string;
  skipChain?: boolean;
  terse?: boolean;
};

export type DebugCommandResult = {
  accessAddress: HexString;
  accountAddress: HexString;
  createdAt: string;
  delegatedKey: {
    chainError?: string;
    chainKey?: {
      expiry?: number;
      id?: HexString;
      publicKey?: HexString;
      role?: string;
    };
    chainStatus: "authorized" | "missing" | "skipped" | "unavailable";
    expiresAt: string;
    localStatus: "active" | "expired" | "invalid";
  };
  grantTxHash?: HexString;
  nativeBalance:
    | {
        status: "available";
        symbol: "ETH";
        wei: string;
      }
    | {
        error?: string;
        status: "skipped" | "unavailable";
      };
  network: Network;
  permissions: AuthorizedKey["permissions"];
  profileMode?: string;
  profilePath: string;
  relayUrl: string;
  rpcUrl: string;
  updatedAt: string;
  walletUrl: string;
};

export type DebugCommandDependencies = {
  createReadClient?: (network: Network, rpcUrl: string) => EthReadClient;
  createRelayClient?: (relayUrl: string, network: Network) => PortoRelayClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  relayActions?: PortoRelayActions;
  stdout?: OutputWriter;
};

type OutputWriter = {
  write(chunk: string): unknown;
};

export function registerDebugCommand(
  wallet: Command,
  dependencies: DebugCommandDependencies = {},
): void {
  wallet
    .command("debug")
    .description("Show local wallet diagnostics without private key material")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--rpc-url <url>", "Ethereum JSON-RPC URL for balance checks")
    .option("--skip-chain", "skip balance and relay key checks")
    .option("--json", "print JSON output")
    .option("-t, --terse", "print compact output")
    .action(async (options: DebugCommandOptions) => {
      await runWalletDebug(options, dependencies);
    });
}

export async function runWalletDebug(
  options: DebugCommandOptions,
  dependencies: DebugCommandDependencies = {},
): Promise<DebugCommandResult> {
  const network = normalizeNetwork(options.network);
  const env = dependencies.env ?? process.env;
  const profile = await readWalletProfile(network, env);
  const rpcUrl = normalizeRpcUrl(options.rpcUrl ?? getDefaultRpcUrl(network));
  const result: DebugCommandResult = {
    accessAddress: profile.accessAddress,
    accountAddress: profile.accountAddress,
    createdAt: profile.createdAt,
    delegatedKey: await inspectDelegatedKey(profile, {
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
    permissions: profile.authorizedKey.permissions,
    profilePath: getProfilePath(network, env),
    relayUrl: profile.relayUrl,
    rpcUrl,
    updatedAt: profile.updatedAt,
    walletUrl: profile.walletUrl,
    ...(profile.grantTxHash === undefined
      ? {}
      : { grantTxHash: profile.grantTxHash }),
  };

  const mode = await readProfileMode(network, env);
  if (mode !== undefined) {
    result.profileMode = mode;
  }

  renderDebugResult(result, options, dependencies.stdout ?? process.stdout);

  return result;
}

async function inspectDelegatedKey(
  profile: WalletProfile,
  options: {
    createRelayClient?: (
      relayUrl: string,
      network: Network,
    ) => PortoRelayClient;
    now?: () => Date;
    relayActions?: PortoRelayActions;
    skipChain?: boolean;
  },
): Promise<DebugCommandResult["delegatedKey"]> {
  const nowSeconds = Math.floor(
    (options.now ?? (() => new Date()))().getTime() / 1000,
  );
  let localStatus: DebugCommandResult["delegatedKey"]["localStatus"] =
    profile.authorizedKey.expiry <= nowSeconds ? "expired" : "active";
  try {
    sessionKeyFromProfile(profile);
  } catch {
    localStatus = "invalid";
  }

  const base = {
    chainStatus: options.skipChain ? "skipped" : "unavailable",
    expiresAt: new Date(profile.authorizedKey.expiry * 1000).toISOString(),
    localStatus,
  } satisfies DebugCommandResult["delegatedKey"];

  if (options.skipChain) {
    return base;
  }

  const actions = options.relayActions ?? portoRelayActions;
  if (!actions.getKeys) {
    return {
      ...base,
      chainError: "relay getKeys is not available",
      chainStatus: "unavailable",
    };
  }

  try {
    const client =
      options.createRelayClient?.(profile.relayUrl, profile.network) ??
      createPortoRelayClient(profile.relayUrl, profile.network);
    const keys = await actions.getKeys(client, {
      account: profile.accountAddress,
      chainIds: [getChainConfig(profile.network).chainId],
    });
    const chainKey = keys.find((key) => keyMatchesProfile(key, profile));

    if (!chainKey) {
      return {
        ...base,
        chainStatus: "missing",
      };
    }

    return {
      ...base,
      chainKey: summarizeChainKey(chainKey),
      chainStatus: "authorized",
    };
  } catch (error) {
    const mapped = relayErrorToCliError(error);
    return {
      ...base,
      chainError: firstLine(mapped.message),
      chainStatus: "unavailable",
    };
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
    const client =
      options.createReadClient?.(options.network, options.rpcUrl) ??
      createEthReadClient(options.network, options.rpcUrl);
    const wei = await client.getBalance(accountAddress);

    return {
      status: "available",
      symbol: "ETH",
      wei: wei.toString(),
    };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.message.length > 0
          ? firstLine(redactString(error.message))
          : undefined,
      status: "unavailable",
    };
  }
}

function renderDebugResult(
  result: DebugCommandResult,
  options: Pick<DebugCommandOptions, "json" | "terse">,
  stdout: OutputWriter,
): void {
  if (options.json) {
    stdout.write(toJson(result));
    return;
  }

  if (options.terse) {
    const balance =
      result.nativeBalance.status === "available"
        ? result.nativeBalance.wei
        : result.nativeBalance.status;
    stdout.write(
      [
        result.network,
        result.accountAddress,
        result.accessAddress,
        result.delegatedKey.localStatus,
        result.delegatedKey.chainStatus,
        balance,
      ]
        .join("\t")
        .concat("\n"),
    );
    return;
  }

  const lines = [
    "Wallet debug diagnostics:",
    `Network: ${result.network}`,
    `Account: ${compactAddress(result.accountAddress)}`,
    `Access key: ${compactAddress(result.accessAddress)}`,
    `Local key: ${result.delegatedKey.localStatus}`,
    `Relay key: ${result.delegatedKey.chainStatus}`,
    `Expires: ${result.delegatedKey.expiresAt}`,
    `Wallet URL: ${result.walletUrl}`,
    `Relay URL: ${result.relayUrl}`,
    `RPC URL: ${result.rpcUrl}`,
    `Profile: ${result.profilePath}`,
  ];

  if (result.profileMode !== undefined) {
    lines.push(`Profile mode: ${result.profileMode}`);
  }

  if (result.nativeBalance.status === "available") {
    lines.push(`Native balance: ${result.nativeBalance.wei} ETH wei`);
  } else {
    lines.push(`Native balance: ${result.nativeBalance.status}`);
  }

  if (result.delegatedKey.chainError !== undefined) {
    lines.push(`Relay key error: ${result.delegatedKey.chainError}`);
  }

  stdout.write(lines.concat("").join("\n"));
}

function keyMatchesProfile(
  key: RelayAccountKey,
  profile: WalletProfile,
): boolean {
  return (
    matchesHex(key.id, profile.accessAddress) ||
    matchesHex(key.publicKey, profile.accessAddress) ||
    matchesHex(key.hash, profile.accessAddress)
  );
}

function summarizeChainKey(
  key: RelayAccountKey,
): NonNullable<DebugCommandResult["delegatedKey"]["chainKey"]> {
  return {
    ...(typeof key.expiry === "number" ? { expiry: key.expiry } : {}),
    ...(isHexString(key.id) ? { id: key.id } : {}),
    ...(isHexString(key.publicKey) ? { publicKey: key.publicKey } : {}),
    ...(typeof key.role === "string" ? { role: key.role } : {}),
  };
}

async function readProfileMode(
  network: Network,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return `0${(await getProfileMode(network, env)).toString(8)}`;
  } catch {
    return undefined;
  }
}

function matchesHex(value: unknown, expected: HexString): boolean {
  return (
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase()
  );
}

function isHexString(value: unknown): value is HexString {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value);
}

function normalizeNetwork(value: string | undefined): Network {
  const network = value ?? defaultNetwork;
  if (!isNetwork(network)) {
    throw new CliError(`unsupported network: ${network}`);
  }
  if (!isSupportedNetwork(network)) {
    throw new CliError(unsupportedNetworkMessage(network));
  }

  return network;
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}
