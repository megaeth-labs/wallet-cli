import { Command } from "commander";

import {
  executeWalletCalls,
  type ExecuteCommandDependencies,
  type ExecuteCommandResult,
  type ExecuteWalletCallsOptions,
} from "./execute.js";
import {
  normalizeNetwork,
  parsePositiveIntegerOption,
  type OutputWriter,
} from "./common.js";
import type { Network } from "../config/chains.js";
import { CliError } from "../errors.js";
import {
  createEthCallClient,
  getDefaultRpcUrl,
  normalizeAddress,
  normalizeRpcUrl,
  type EthCallClient,
} from "../eth/client.js";
import {
  encodeErc20TransferCall,
  parseDecimalUnits,
  readErc20Metadata,
  type Erc20Metadata,
} from "../eth/erc20.js";
import { compactAddress, toJson } from "../output.js";

export type TransferCommandOptions = {
  amount?: string;
  decimals?: number;
  json?: boolean;
  key?: string;
  network?: string;
  pollIntervalMs: number;
  rpcUrl?: string;
  terse?: boolean;
  timeoutMs: number;
  to?: string;
  token?: string;
};

export type TransferDetails =
  | {
      amount: string;
      asset: "native";
      to: `0x${string}`;
      value: string;
    }
  | {
      amount: string;
      asset: "erc20";
      decimals: number;
      to: `0x${string}`;
      token: `0x${string}`;
      units: string;
      symbol?: string;
    };

export type TransferCommandResult = ExecuteCommandResult & {
  transfer: TransferDetails;
};

export type TransferCommandDependencies = ExecuteCommandDependencies & {
  createTokenClient?: (network: Network, rpcUrl: string) => EthCallClient;
  executeWalletCalls?: ExecuteWalletCallsExecutor;
  readTokenMetadata?: TokenMetadataReader;
};

type ExecuteWalletCallsExecutor = (
  options: ExecuteWalletCallsOptions,
  dependencies: ExecuteCommandDependencies,
) => Promise<ExecuteCommandResult>;

type TokenMetadataReader = (options: {
  network: Network;
  rpcUrl: string;
  token: `0x${string}`;
}) => Promise<Erc20Metadata>;

export function registerTransferCommand(
  wallet: Command,
  dependencies: TransferCommandDependencies = {},
): void {
  wallet
    .command("transfer")
    .description("Transfer native ETH or ERC20 tokens through wallet execute")
    .requiredOption("--to <address>", "recipient address")
    .requiredOption("--amount <amount>", "amount in ETH or token units")
    .option("--token <address>", "ERC20 token contract address")
    .option("--key <key>", "delegated key id or access address to use")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option(
      "--decimals <decimals>",
      "ERC20 token decimals override",
      parseDecimals,
    )
    .option("--rpc-url <url>", "Ethereum JSON-RPC URL for token metadata")
    .option(
      "--poll-interval-ms <ms>",
      "deprecated; ignored for direct relay sends",
      parsePositiveIntegerOption,
      1_000,
    )
    .option(
      "--timeout-ms <ms>",
      "deprecated; ignored for direct relay sends",
      parsePositiveIntegerOption,
      120_000,
    )
    .option("--json", "print JSON output")
    .option("-t, --terse", "print compact output")
    .action(async (options: TransferCommandOptions) => {
      await runWalletTransfer(options, dependencies);
    });
}

export async function runWalletTransfer(
  options: TransferCommandOptions,
  dependencies: TransferCommandDependencies = {},
): Promise<TransferCommandResult> {
  const network = normalizeNetwork(options.network);
  const transfer = await buildTransfer(options, network, dependencies);
  const executor = dependencies.executeWalletCalls ?? executeWalletCalls;
  const execution = await executor(
    {
      calls: [transfer.call],
      ...(options.key === undefined ? {} : { key: options.key }),
      network,
    },
    dependencies,
  );
  const result = {
    ...execution,
    transfer: transfer.details,
  };

  renderTransferResult(result, options, dependencies.stdout ?? process.stdout);

  return result;
}

async function buildTransfer(
  options: TransferCommandOptions,
  network: Network,
  dependencies: TransferCommandDependencies,
): Promise<{
  call: ExecuteWalletCallsOptions["calls"][number];
  details: TransferDetails;
}> {
  const amount = normalizeAmount(options.amount);
  const recipient = normalizeAddress(options.to, "transfer recipient");

  if (options.token === undefined) {
    if (options.decimals !== undefined) {
      throw new CliError("--decimals can only be used with --token");
    }

    const value = parseDecimalUnits(amount, 18, "transfer amount");

    return {
      call: {
        data: "0x",
        to: recipient,
        value,
      },
      details: {
        amount,
        asset: "native",
        to: recipient,
        value: value.toString(),
      },
    };
  }

  const token = normalizeAddress(options.token, "ERC20 token");
  const metadata = await resolveTokenMetadata(
    options,
    network,
    token,
    dependencies,
  );
  const units = parseDecimalUnits(amount, metadata.decimals, "transfer amount");

  return {
    call: {
      data: encodeErc20TransferCall(recipient, units),
      to: token,
      value: 0n,
    },
    details: {
      amount,
      asset: "erc20",
      decimals: metadata.decimals,
      to: recipient,
      token,
      units: units.toString(),
      ...(metadata.symbol === undefined ? {} : { symbol: metadata.symbol }),
    },
  };
}

async function resolveTokenMetadata(
  options: Pick<TransferCommandOptions, "decimals" | "rpcUrl">,
  network: Network,
  token: `0x${string}`,
  dependencies: TransferCommandDependencies,
): Promise<Erc20Metadata> {
  if (options.decimals !== undefined) {
    return { decimals: options.decimals };
  }

  const rpcUrl = normalizeRpcUrl(options.rpcUrl ?? getDefaultRpcUrl(network));
  const readMetadata: TokenMetadataReader =
    dependencies.readTokenMetadata ??
    ((metadataOptions) => {
      const client =
        dependencies.createTokenClient?.(
          metadataOptions.network,
          metadataOptions.rpcUrl,
        ) ??
        createEthCallClient(metadataOptions.network, metadataOptions.rpcUrl);
      return readErc20Metadata(client, metadataOptions.token);
    });

  try {
    return await readMetadata({ network, rpcUrl, token });
  } catch (error) {
    const suffix =
      error instanceof Error && error.message.length > 0
        ? `: ${firstLine(error.message)}`
        : "";
    throw new CliError(
      `failed to read ERC20 decimals; pass --decimals or --rpc-url${suffix}`,
    );
  }
}

function renderTransferResult(
  result: TransferCommandResult,
  options: Pick<TransferCommandOptions, "json" | "terse">,
  stdout: OutputWriter,
): void {
  if (options.json) {
    stdout.write(toJson(result, { preserveKeys: ["transactionHash"] }));
    return;
  }

  const transactionHash =
    result.transactionHash ??
    result.receipts?.[result.receipts.length - 1]?.transactionHash;

  if (options.terse) {
    stdout.write(
      [result.id, result.status.toString(), transactionHash ?? ""]
        .join("\t")
        .concat("\n"),
    );
    return;
  }

  const asset =
    result.transfer.asset === "native"
      ? "ETH"
      : `${result.transfer.symbol ?? "ERC20"} ${compactAddress(result.transfer.token)}`;
  const lines = [
    "Transfer submitted.",
    `Asset: ${asset}`,
    `Amount: ${result.transfer.amount}`,
    `To: ${compactAddress(result.transfer.to)}`,
    `Status: ${result.status}`,
    `Network: ${result.network}`,
  ];

  if (transactionHash !== undefined) {
    lines.push(`Transaction: ${transactionHash}`);
  }

  stdout.write(lines.join("\n").concat("\n"));
}

function normalizeAmount(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliError("transfer amount is required");
  }

  return value.trim();
}

function parseDecimals(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new CliError("token decimals must be an integer from 0 to 255");
  }

  return parsed;
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}
