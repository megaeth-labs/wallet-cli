import { Command } from "commander";

import { getChainConfig, isNetwork, type Network } from "../config/chains.js";
import { summarizeProfile, type WalletProfile } from "../config/profile.js";
import { CliError } from "../errors.js";
import { compactAddress, toJson } from "../output.js";
import { runLoopbackLogin } from "../auth/loopback.js";
import { resolveLoginPermissions } from "../auth/permissions.js";

type LoginCommandOptions = {
  network: string;
  walletUrl?: string;
  relayUrl?: string;
  permissions?: string;
  allowCall: string[];
  timeoutMs: number;
  json?: boolean;
  terse?: boolean;
};

export function registerWalletCommands(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("Manage MegaETH wallet workflows");

  wallet
    .command("login")
    .description("Authorize a local delegated key with the MegaETH wallet")
    .option("--network <network>", "wallet network", "testnet")
    .option("--wallet-url <url>", "wallet UI URL")
    .option("--relay-url <url>", "MegaETH relay URL")
    .option(
      "--permissions <file>",
      "JSON file containing requested permissions",
    )
    .option(
      "--allow-call <target:signature>",
      "allow a target function call",
      collect,
      [],
    )
    .option(
      "--timeout-ms <ms>",
      "loopback authorization timeout",
      parsePositiveInteger,
      120_000,
    )
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: LoginCommandOptions) => {
      const profile = await login(options);
      process.stdout.write(renderLogin(profile, options));
    });

  wallet
    .command("whoami")
    .description("Show the active wallet account and delegated key")
    .action(() => {
      throw new CliError("wallet whoami is not implemented yet");
    });

  wallet
    .command("keys")
    .description("List locally known delegated keys")
    .action(() => {
      throw new CliError("wallet keys is not implemented yet");
    });

  wallet
    .command("logout")
    .description("Remove the local wallet profile")
    .action(() => {
      throw new CliError("wallet logout is not implemented yet");
    });

  wallet
    .command("call")
    .description("Run a read-only eth_call")
    .action(() => {
      throw new CliError("wallet call is not implemented yet");
    });

  wallet
    .command("execute")
    .description("Submit one or more write calls through the MegaETH relay")
    .action(() => {
      throw new CliError("wallet execute is not implemented yet");
    });

  wallet
    .command("transfer")
    .description("Transfer native ETH or ERC20 tokens through wallet execute")
    .action(() => {
      throw new CliError("wallet transfer is not implemented yet");
    });
}

export async function login(
  options: LoginCommandOptions,
): Promise<WalletProfile> {
  const network = parseNetwork(options.network);
  const chainConfig = getChainConfig(network);
  const walletUrl = options.walletUrl ?? chainConfig.walletUrl;
  const relayUrl = options.relayUrl ?? chainConfig.relayUrl;

  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  assertHttpUrl(relayUrl, "relay-url must be an HTTP(S) URL");

  const permissionRequest = await resolveLoginPermissions({
    permissionsFile: options.permissions,
    allowCalls: options.allowCall,
  });

  const { profile } = await runLoopbackLogin({
    network,
    permissionRequest,
    walletUrl,
    relayUrl,
    timeoutMs: options.timeoutMs,
  });

  return profile;
}

function renderLogin(
  profile: WalletProfile,
  options: LoginCommandOptions,
): string {
  if (options.json) {
    return toJson(summarizeProfile(profile));
  }

  const expiry = new Date(profile.authorizedKey.expiry * 1000).toISOString();
  if (options.terse) {
    return [
      profile.network,
      profile.accountAddress,
      profile.accessAddress,
      profile.authorizedKey.expiry.toString(),
    ]
      .join("\t")
      .concat("\n");
  }

  return [
    `Logged in to ${profile.network}.`,
    `Account: ${compactAddress(profile.accountAddress)}`,
    `Delegated key: ${compactAddress(profile.accessAddress)}`,
    `Expires: ${expiry}`,
  ]
    .join("\n")
    .concat("\n");
}

function parseNetwork(value: string): Network {
  if (!isNetwork(value)) {
    throw new CliError(`unsupported network: ${value}`);
  }

  return value;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError("timeout-ms must be a positive integer");
  }

  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function assertHttpUrl(value: string, message: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new CliError(message);
  }
}
