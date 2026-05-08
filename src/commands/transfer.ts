import { Command } from "commander";

import {
  executeWalletCalls,
  type ExecuteCommandDependencies,
  type ExecuteCommandResult,
  type ExecuteWalletCallsOptions,
} from "./execute.js";
import { CliError } from "../errors.js";
import { normalizeAddress } from "../eth/client.js";
import { encodeErc20TransferCall, parseDecimalUnits } from "../eth/erc20.js";
import { compactAddress, redactString, toJson } from "../output.js";

export type TransferCommandOptions = {
  amount?: string;
  decimals?: number;
  json?: boolean;
  network?: string;
  pollIntervalMs: number;
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
    };

export type TransferCommandResult = ExecuteCommandResult & {
  transfer: TransferDetails;
};

export type TransferCommandDependencies = ExecuteCommandDependencies & {
  executeWalletCalls?: ExecuteWalletCallsExecutor;
};

type ExecuteWalletCallsExecutor = (
  options: ExecuteWalletCallsOptions,
  dependencies: ExecuteCommandDependencies,
) => Promise<ExecuteCommandResult>;

type OutputWriter = {
  write(chunk: string): unknown;
};

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
    .option("--decimals <decimals>", "ERC20 token decimals", parseDecimals)
    .option("--network <network>", "MegaETH network", "testnet")
    .option(
      "--poll-interval-ms <ms>",
      "relay status polling interval",
      parsePositiveInteger,
      1_000,
    )
    .option(
      "--timeout-ms <ms>",
      "relay status polling timeout",
      parsePositiveInteger,
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
  const transfer = buildTransfer(options);
  const executor = dependencies.executeWalletCalls ?? executeWalletCalls;
  const execution = await executor(
    {
      calls: [transfer.call],
      network: options.network,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
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

function buildTransfer(options: TransferCommandOptions): {
  call: ExecuteWalletCallsOptions["calls"][number];
  details: TransferDetails;
} {
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

  if (options.decimals === undefined) {
    throw new CliError("provide --decimals for ERC20 transfers");
  }

  const token = normalizeAddress(options.token, "ERC20 token");
  const units = parseDecimalUnits(amount, options.decimals, "transfer amount");

  return {
    call: {
      data: encodeErc20TransferCall(recipient, units),
      to: token,
      value: 0n,
    },
    details: {
      amount,
      asset: "erc20",
      decimals: options.decimals,
      to: recipient,
      token,
      units: units.toString(),
    },
  };
}

function renderTransferResult(
  result: TransferCommandResult,
  options: Pick<TransferCommandOptions, "json" | "terse">,
  stdout: OutputWriter,
): void {
  if (options.json) {
    stdout.write(toJson(result));
    return;
  }

  const transactionHash =
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
      : `ERC20 ${compactAddress(result.transfer.token)}`;
  const lines = [
    "Transfer submitted.",
    `Asset: ${asset}`,
    `Amount: ${result.transfer.amount}`,
    `To: ${compactAddress(result.transfer.to)}`,
    `Bundle: ${redactString(result.id)}`,
    `Status: ${result.status}`,
    `Network: ${result.network}`,
  ];

  if (transactionHash !== undefined) {
    lines.push(`Transaction: ${redactString(transactionHash)}`);
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

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError("value must be a positive integer");
  }

  return parsed;
}
