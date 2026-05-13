import { readFile } from "node:fs/promises";

import { Command } from "commander";

import { defaultNetwork, isNetwork, type Network } from "../config/chains.js";
import {
  markWalletKeyUsed,
  readWalletProfile,
  requireUsableWalletKey,
  writeWalletProfile,
  type HexString,
  type WalletKeyRecord,
  type WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import { normalizeAddress, normalizeHexResult } from "../eth/client.js";
import { compactAddress, redactString, toJson } from "../output.js";
import {
  createPortoRelayClient,
  relayErrorToCliError,
  sendRelayCalls,
  type PortoRelayActions,
  type PortoRelayClient,
  type RelayCall,
} from "../relay/sendCalls.js";
import { sessionKeyFromWalletKey } from "../relay/sessionKey.js";
import {
  isSuccessfulRelayStatus,
  pollRelayCallsStatus,
  type RelayCallsStatus,
} from "../relay/status.js";

export type ExecuteCommandOptions = {
  calls?: string;
  data?: string;
  json?: boolean;
  key?: string;
  network?: string;
  pollIntervalMs: number;
  terse?: boolean;
  timeoutMs: number;
  to?: string;
  value?: string;
};

export type ExecuteCallInput = {
  data?: unknown;
  to: unknown;
  value?: unknown;
};

export type ExecuteWalletCallsOptions = {
  calls: readonly ExecuteCallInput[];
  key?: string;
  network?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type ExecuteCommandResult = {
  accessAddress: HexString;
  accountAddress: HexString;
  id: HexString;
  network: Network;
  receipts: RelayCallsStatus["receipts"];
  relayUrl: string;
  status: number;
};

export type ExecuteCommandDependencies = {
  createRelayClient?: (relayUrl: string, network: Network) => PortoRelayClient;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readProfile?: (
    network: Network,
    env: NodeJS.ProcessEnv,
  ) => Promise<WalletProfile>;
  relayActions?: PortoRelayActions;
  sleep?: (ms: number) => Promise<void>;
  stdout?: OutputWriter;
  writeProfile?: (
    profile: WalletProfile,
    env: NodeJS.ProcessEnv,
  ) => Promise<void>;
};

type OutputWriter = {
  write(chunk: string): unknown;
};

export function registerExecuteCommand(
  wallet: Command,
  dependencies: ExecuteCommandDependencies = {},
): void {
  wallet
    .command("execute")
    .description("Submit one or more write calls through the MegaETH relay")
    .option("--to <address>", "contract address to call")
    .option("--data <hex>", "raw calldata")
    .option("--value <wei>", "native value in wei")
    .option("--calls <path>", "JSON file containing calls to execute")
    .option("--key <key>", "delegated key id or access address to use")
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
    .action(async (options: ExecuteCommandOptions) => {
      await runWalletExecute(options, dependencies);
    });
}

export async function runWalletExecute(
  options: ExecuteCommandOptions,
  dependencies: ExecuteCommandDependencies = {},
): Promise<ExecuteCommandResult> {
  const result = await executeWalletCalls(
    {
      calls: await resolveCliCalls(options),
      ...(options.key === undefined ? {} : { key: options.key }),
      network: options.network,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
    },
    dependencies,
  );

  renderExecuteResult(result, options, dependencies.stdout ?? process.stdout);

  return result;
}

export async function executeWalletCalls(
  options: ExecuteWalletCallsOptions,
  dependencies: ExecuteCommandDependencies = {},
): Promise<ExecuteCommandResult> {
  const network = normalizeNetwork(options.network);
  const calls = normalizeCalls(options.calls);
  const env = dependencies.env ?? process.env;
  const profile = await (dependencies.readProfile ?? readWalletProfile)(
    network,
    env,
  );

  const selectedKey = requireUsableWalletKey(
    profile,
    options.key,
    (dependencies.now ?? (() => new Date()))(),
  );
  const sessionKey = sessionKeyFromWalletKey(selectedKey);
  const client =
    dependencies.createRelayClient?.(profile.relayUrl, network) ??
    createPortoRelayClient(profile.relayUrl, network);

  try {
    const sent = await sendRelayCalls({
      accountAddress: profile.accountAddress,
      actions: dependencies.relayActions,
      calls,
      client,
      sessionKey,
    });
    const status = await pollRelayCallsStatus({
      actions: dependencies.relayActions,
      client,
      id: sent.id,
      intervalMs: options.pollIntervalMs,
      sleep: dependencies.sleep,
      timeoutMs: options.timeoutMs,
    });

    if (!isSuccessfulRelayStatus(status.status)) {
      throw new CliError(
        `relay call bundle ${redactString(sent.id)} failed with status ${status.status}`,
      );
    }

    await markSelectedKeyUsed(profile, selectedKey, env, dependencies);

    return {
      accessAddress: selectedKey.accessAddress,
      accountAddress: profile.accountAddress,
      id: sent.id,
      network,
      receipts: status.receipts,
      relayUrl: profile.relayUrl,
      status: status.status,
    };
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    throw relayErrorToCliError(error);
  }
}

async function resolveCliCalls(
  options: ExecuteCommandOptions,
): Promise<ExecuteCallInput[]> {
  const hasCallsFile = options.calls !== undefined;
  const hasSingleCall =
    options.to !== undefined ||
    options.data !== undefined ||
    options.value !== undefined;

  if (hasCallsFile && hasSingleCall) {
    throw new CliError("use either --calls or --to/--data/--value, not both");
  }

  if (hasCallsFile) {
    const raw = await readCallsFile(options.calls);
    if (!Array.isArray(raw)) {
      throw new CliError("calls file must contain a JSON array");
    }

    return raw.map((entry) => {
      if (!isObject(entry)) {
        throw new CliError("each calls file entry must be an object");
      }

      return {
        data: entry["data"],
        to: entry["to"],
        value: entry["value"],
      };
    });
  }

  if (options.to === undefined) {
    throw new CliError("provide --to or --calls");
  }

  return [
    {
      data: options.data,
      to: options.to,
      value: options.value,
    },
  ];
}

async function readCallsFile(path: string | undefined): Promise<unknown> {
  if (path === undefined || path.length === 0) {
    throw new CliError("calls file path is required");
  }

  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new CliError("calls file is not valid JSON");
    }

    throw error;
  }
}

function normalizeCalls(calls: readonly ExecuteCallInput[]): RelayCall[] {
  if (calls.length === 0) {
    throw new CliError("provide at least one call to execute");
  }

  return calls.map((call) => ({
    data: normalizeHexResult(call.data ?? "0x", "execute call data"),
    to: normalizeAddress(call.to, "execute target"),
    value: normalizeValue(call.value ?? "0"),
  }));
}

function normalizeValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new CliError("execute value must be non-negative");
    }
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CliError("execute value must be a non-negative integer");
    }
    return BigInt(value);
  }

  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value)) {
      return BigInt(value);
    }
    if (/^\d+$/.test(value)) {
      return BigInt(value);
    }
  }

  throw new CliError("execute value must be a non-negative integer");
}

async function markSelectedKeyUsed(
  profile: WalletProfile,
  selectedKey: WalletKeyRecord,
  env: NodeJS.ProcessEnv,
  dependencies: ExecuteCommandDependencies,
): Promise<void> {
  const writer =
    dependencies.writeProfile ??
    (dependencies.readProfile === undefined ? writeWalletProfile : undefined);

  if (writer === undefined) {
    return;
  }

  await writer(
    markWalletKeyUsed(
      profile,
      selectedKey.id,
      (dependencies.now ?? (() => new Date()))(),
    ),
    env,
  );
}

function normalizeNetwork(value: string | undefined): Network {
  const network = value ?? defaultNetwork;
  if (!isNetwork(network)) {
    throw new CliError(`unsupported network: ${network}`);
  }

  return network;
}

function renderExecuteResult(
  result: ExecuteCommandResult,
  options: Pick<ExecuteCommandOptions, "json" | "terse">,
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

  const lines = [
    "Relay call bundle submitted.",
    `Bundle: ${redactString(result.id)}`,
    `Status: ${result.status}`,
    `Network: ${result.network}`,
    `Account: ${compactAddress(result.accountAddress)}`,
    `Delegated key: ${compactAddress(result.accessAddress)}`,
  ];
  if (transactionHash !== undefined) {
    lines.push(`Transaction: ${redactString(transactionHash)}`);
  }

  stdout.write(lines.join("\n").concat("\n"));
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError("value must be a positive integer");
  }

  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
