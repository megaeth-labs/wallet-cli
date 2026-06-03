import { Command } from "commander";

import { normalizeNetwork, type OutputWriter } from "./common.js";
import type { Network } from "../config/chains.js";
import { readWalletProfile, type WalletProfile } from "../config/profile.js";
import { CliError } from "../errors.js";
import { encodeAbiCall, loadAbiFile, parseAbiArgs } from "../eth/abi.js";
import {
  createEthCallClient,
  getDefaultRpcUrl,
  normalizeAddress,
  normalizeHexResult,
  normalizeRpcUrl,
  type EthCallClient,
  type HexString,
} from "../eth/client.js";
import {
  createTerminalStyle,
  formatTerminalFieldLines,
} from "../terminal/style.js";

export type CallCommandOptions = {
  abi?: string;
  args?: string;
  data?: string;
  from?: string;
  function?: string;
  json?: boolean;
  network?: string;
  rpcUrl?: string;
  terse?: boolean;
  to?: string;
};

export type CallCommandResult = {
  data: HexString;
  from?: `0x${string}`;
  network: Network;
  result: HexString;
  rpcUrl: string;
  to: `0x${string}`;
};

export type CallCommandDependencies = {
  createClient?: (network: Network, rpcUrl: string) => EthCallClient;
  env?: NodeJS.ProcessEnv;
  readProfile?: (
    network: Network,
    env: NodeJS.ProcessEnv,
  ) => Promise<WalletProfile>;
  stdout?: OutputWriter;
};

export function registerCallCommand(
  wallet: Command,
  dependencies: CallCommandDependencies = {},
): void {
  wallet
    .command("call")
    .description("Run a read-only eth_call")
    .requiredOption("--to <address>", "contract address to call")
    .option("--data <hex>", "raw calldata")
    .option("--from <address>", "eth_call sender address")
    .option("--abi <path>", "contract ABI JSON file")
    .option("--function <name>", "ABI function name")
    .option("--args <json>", "ABI function args as a JSON array")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--rpc-url <url>", "Ethereum JSON-RPC URL")
    .option("--json", "print JSON output")
    .option("-t, --terse", "print compact output")
    .action(async (options: CallCommandOptions) => {
      await runWalletCall(options, dependencies);
    });
}

export async function runWalletCall(
  options: CallCommandOptions,
  dependencies: CallCommandDependencies = {},
): Promise<CallCommandResult> {
  const network = normalizeNetwork(options.network);
  const rpcUrl = normalizeRpcUrl(options.rpcUrl ?? getDefaultRpcUrl(network));
  const to = normalizeAddress(options.to, "call target");
  const from = await resolveFrom(options, network, dependencies);
  const data = await resolveCallData(options);
  const client =
    dependencies.createClient?.(network, rpcUrl) ??
    createEthCallClient(network, rpcUrl);
  const result = await executeEthCall(client, { data, from, to });
  const commandResult = {
    data,
    ...(from === undefined ? {} : { from }),
    network,
    result,
    rpcUrl,
    to,
  };

  renderCallResult(
    commandResult,
    options,
    dependencies.stdout ?? process.stdout,
    dependencies.env,
  );

  return commandResult;
}

async function executeEthCall(
  client: EthCallClient,
  request: { data: HexString; from?: `0x${string}`; to: `0x${string}` },
): Promise<HexString> {
  try {
    return await client.call(request);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    const suffix =
      error instanceof Error && error.message.length > 0
        ? `: ${firstLine(error.message)}`
        : "";
    throw new CliError(`eth_call failed${suffix}`);
  }
}

async function resolveFrom(
  options: CallCommandOptions,
  network: Network,
  dependencies: CallCommandDependencies,
): Promise<`0x${string}` | undefined> {
  if (options.from !== undefined) {
    return normalizeAddress(options.from, "call sender");
  }

  try {
    const profile = await (dependencies.readProfile ?? readWalletProfile)(
      network,
      dependencies.env ?? process.env,
    );
    return profile.accountAddress;
  } catch (error) {
    if (
      error instanceof CliError &&
      error.message.includes(`no ${network} wallet profile found`)
    ) {
      return undefined;
    }
    throw error;
  }
}

async function resolveCallData(
  options: CallCommandOptions,
): Promise<HexString> {
  const hasRawData = options.data !== undefined;
  const hasAbiInput =
    options.abi !== undefined ||
    options.function !== undefined ||
    options.args !== undefined;

  if (hasRawData && hasAbiInput) {
    throw new CliError(
      "use either --data or --abi/--function/--args, not both",
    );
  }

  if (hasRawData) {
    return normalizeHexResult(options.data, "call data");
  }

  if (options.abi === undefined || options.function === undefined) {
    throw new CliError("provide --data or both --abi and --function");
  }

  const abi = await loadAbiFile(options.abi);
  const args = parseAbiArgs(options.args);

  return encodeAbiCall(abi, options.function, args);
}

function renderCallResult(
  result: CallCommandResult,
  options: CallCommandOptions,
  stdout: OutputWriter,
  env?: NodeJS.ProcessEnv,
): void {
  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (options.terse) {
    stdout.write(`${result.result}\n`);
    return;
  }

  const style = createTerminalStyle({
    env,
    json: options.json,
    stream: stdout,
    terse: options.terse,
  });

  stdout.write(
    formatTerminalFieldLines(
      [
        ["Result", style.accent(result.result)],
        ["Network", result.network],
        ["RPC URL", result.rpcUrl],
        ["To", style.accent(result.to)],
        result.from === undefined
          ? undefined
          : ["From", style.accent(result.from)],
      ],
      style,
    )
      .concat("")
      .join("\n"),
  );
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}
