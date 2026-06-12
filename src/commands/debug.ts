import { Command } from "commander";

import type { OutputWriter } from "./common.js";
import { getWalletDebug } from "../core/wallet-debug.js";
import type { Network } from "../config/chains.js";
import { formatTokenAmount } from "../config/permissionSummary.js";
import type { AuthorizedKey, HexString } from "../config/profile.js";
import type { EthReadClient } from "../eth/client.js";
import { toJson } from "../output.js";
import {
  createTerminalStyle,
  formatTerminalFieldLines,
} from "../terminal/style.js";
import type { PortoRelayActions, PortoRelayClient } from "../relay/sendCalls.js";

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

export function registerDebugCommand(
  wallet: Command,
  dependencies: DebugCommandDependencies = {},
): void {
  wallet
    .command("debug")
    .description("Show local wallet diagnostics without private key material")
    .option("--network <network>", "wallet network: mainnet or testnet")
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
  const result = await getWalletDebug(options, dependencies);

  renderDebugResult(
    result,
    options,
    dependencies.stdout ?? process.stdout,
    dependencies.env,
  );

  return result;
}

function renderDebugResult(
  result: DebugCommandResult,
  options: Pick<DebugCommandOptions, "json" | "terse">,
  stdout: OutputWriter,
  env?: NodeJS.ProcessEnv,
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

  const style = createTerminalStyle({
    env,
    json: options.json,
    stream: stdout,
    terse: options.terse,
  });
  const lines = [
    style.strong("Wallet debug diagnostics:"),
    "",
    ...formatTerminalFieldLines(
      [
        ["Network", result.network],
        ["Account", style.accent(result.accountAddress)],
        ["Access key", style.accent(result.accessAddress)],
        ["Local key", result.delegatedKey.localStatus],
        ["Relay key", result.delegatedKey.chainStatus],
        ["Expires", result.delegatedKey.expiresAt],
        ["Wallet URL", result.walletUrl],
        ["Relay URL", result.relayUrl],
        ["RPC URL", result.rpcUrl],
        ["Profile", result.profilePath],
      ],
      style,
    ),
  ];

  if (result.profileMode !== undefined) {
    lines.push(`${style.dim("Profile mode")}: ${result.profileMode}`);
  }

  if (result.nativeBalance.status === "available") {
    lines.push(
      `${style.dim("Native balance")}: ${result.nativeBalance.wei} wei (${formatTokenAmount(
        result.nativeBalance.wei,
        undefined,
      )} ETH)`,
    );
  } else {
    lines.push(
      `${style.dim("Native balance")}: ${result.nativeBalance.status}`,
    );
  }

  if (result.delegatedKey.chainError !== undefined) {
    lines.push(
      style.error(`Relay key error: ${result.delegatedKey.chainError}`),
    );
  }

  stdout.write(lines.concat("").join("\n"));
}
