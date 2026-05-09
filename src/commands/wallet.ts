import { Command } from "commander";

import { registerCallCommand } from "./call.js";
import {
  registerDebugCommand,
  type DebugCommandDependencies,
} from "./debug.js";
import { registerExecuteCommand } from "./execute.js";
import { registerFundCommand, type FundCommandDependencies } from "./fund.js";
import {
  registerTransferCommand,
  type TransferCommandDependencies,
} from "./transfer.js";
import {
  defaultNetwork,
  getChainConfig,
  isNetwork,
  isSupportedNetwork,
  type Network,
  unsupportedNetworkMessage,
} from "../config/chains.js";
import {
  deleteWalletProfile,
  readWalletProfile,
  summarizeProfile,
  type AuthorizedKey,
  type ProfileSummary,
  type WalletProfile,
} from "../config/profile.js";
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

type StatusCommandOptions = {
  network?: string;
  json?: boolean;
  terse?: boolean;
};

type OutputWriter = {
  write(chunk: string): unknown;
};

export type WalletCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  debug?: DebugCommandDependencies;
  fund?: FundCommandDependencies;
  now?: () => Date;
  stdout?: OutputWriter;
  transfer?: TransferCommandDependencies;
};

export type WalletStatusResult = ProfileSummary & {
  expired: boolean;
  expiresAt: string;
};

export type WalletKeysResult = {
  network: Network;
  keys: WalletKeySummary[];
};

export type WalletKeySummary = {
  accessAddress: `0x${string}`;
  authorizedKey: AuthorizedKey;
  expired: boolean;
  expiresAt: string;
};

export type WalletLogoutResult = {
  network: Network;
  accountAddress: `0x${string}`;
  accessAddress: `0x${string}`;
  removed: boolean;
};

export function registerWalletCommands(
  program: Command,
  dependencies: WalletCommandDependencies = {},
): void {
  const wallet = program
    .command("wallet")
    .description("Manage MegaETH wallet workflows");

  registerWalletSubcommands(wallet, dependencies);
}

export function registerWalletSubcommands(
  wallet: Command,
  dependencies: WalletCommandDependencies = {},
): void {
  wallet
    .command("login")
    .description("Authorize a local delegated key with the MegaETH wallet")
    .option("--network <network>", "wallet network", defaultNetwork)
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
      getStdout(dependencies).write(renderLogin(profile, options));
    });

  wallet
    .command("whoami")
    .description("Show the active wallet account and delegated key")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletWhoami(options, dependencies);
    });

  wallet
    .command("keys")
    .description("List locally known delegated keys")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletKeys(options, dependencies);
    });

  wallet
    .command("logout")
    .description("Remove the local wallet profile")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletLogout(options, dependencies);
    });

  registerCallCommand(wallet);
  registerExecuteCommand(wallet);
  registerFundCommand(wallet, {
    env: dependencies.env,
    stdout: dependencies.stdout,
    ...dependencies.fund,
  });
  registerDebugCommand(wallet, {
    env: dependencies.env,
    now: dependencies.now,
    stdout: dependencies.stdout,
    ...dependencies.debug,
  });
  registerTransferCommand(wallet, {
    env: dependencies.env,
    now: dependencies.now,
    stdout: dependencies.stdout,
    ...dependencies.transfer,
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

export async function runWalletWhoami(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletStatusResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const result = buildStatusResult(profile, getNow(dependencies));

  getStdout(dependencies).write(renderWhoami(result, options));

  return result;
}

export async function runWalletKeys(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletKeysResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const status = buildStatusResult(profile, getNow(dependencies));
  const result: WalletKeysResult = {
    network,
    keys: [
      {
        accessAddress: status.accessAddress,
        authorizedKey: status.authorizedKey,
        expired: status.expired,
        expiresAt: status.expiresAt,
      },
    ],
  };

  getStdout(dependencies).write(renderKeys(result, options));

  return result;
}

export async function runWalletLogout(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletLogoutResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  await deleteWalletProfile(network, dependencies.env);

  const result: WalletLogoutResult = {
    network,
    accountAddress: profile.accountAddress,
    accessAddress: profile.accessAddress,
    removed: true,
  };

  getStdout(dependencies).write(renderLogout(result, options));

  return result;
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

function renderWhoami(
  result: WalletStatusResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }

  const status = result.expired ? "expired" : "active";
  if (options.terse) {
    return [
      result.network,
      result.accountAddress,
      result.accessAddress,
      status,
      result.authorizedKey.expiry.toString(),
    ]
      .join("\t")
      .concat("\n");
  }

  const lines = [
    `Network: ${result.network}`,
    `Account: ${compactAddress(result.accountAddress)}`,
    `Delegated key: ${compactAddress(result.accessAddress)}`,
    `Status: ${status}`,
    `Expires: ${result.expiresAt}`,
    ...renderPermissionLines(result.authorizedKey),
  ];

  if (result.expired) {
    lines.unshift(`Warning: delegated key expired at ${result.expiresAt}`);
  }

  return lines.join("\n").concat("\n");
}

function renderKeys(
  result: WalletKeysResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return result.keys
      .map((key) =>
        [
          result.network,
          key.accessAddress,
          key.expired ? "expired" : "active",
          key.authorizedKey.expiry.toString(),
        ].join("\t"),
      )
      .join("\n")
      .concat(result.keys.length > 0 ? "\n" : "");
  }

  const lines = [`Delegated keys for ${result.network}:`];
  for (const key of result.keys) {
    lines.push(
      `- ${compactAddress(key.accessAddress)} (${key.expired ? "expired" : "active"}, expires ${key.expiresAt})`,
      ...renderPermissionLines(key.authorizedKey).map((line) => `  ${line}`),
    );
  }

  return lines.join("\n").concat("\n");
}

function renderLogout(
  result: WalletLogoutResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return [result.network, "removed", result.accessAddress]
      .join("\t")
      .concat("\n");
  }

  return [
    `Removed ${result.network} wallet profile.`,
    `Account: ${compactAddress(result.accountAddress)}`,
    `Delegated key: ${compactAddress(result.accessAddress)}`,
  ]
    .join("\n")
    .concat("\n");
}

function renderPermissionLines(authorizedKey: AuthorizedKey): string[] {
  const callLines =
    authorizedKey.permissions.calls.length === 0
      ? ["Calls: none"]
      : authorizedKey.permissions.calls.map(
          (call) => `Call: ${compactAddress(call.to)} ${call.signature}`,
        );
  const spendLines =
    authorizedKey.permissions.spend.length === 0
      ? ["Spend: none"]
      : authorizedKey.permissions.spend.map((spend) => {
          const token =
            spend.token === undefined ? "native" : compactAddress(spend.token);
          return `Spend: ${spend.limit}/${spend.period} ${token}`;
        });
  const feeToken =
    authorizedKey.feeToken === undefined
      ? []
      : [
          `Fee token: ${authorizedKey.feeToken.limit} ${authorizedKey.feeToken.symbol ?? "token"}`,
        ];

  return [...callLines, ...spendLines, ...feeToken];
}

function buildStatusResult(
  profile: WalletProfile,
  now: Date,
): WalletStatusResult {
  const summary = summarizeProfile(profile);
  const expiresAt = new Date(profile.authorizedKey.expiry * 1000).toISOString();

  return {
    ...summary,
    expired: profile.authorizedKey.expiry * 1000 <= now.getTime(),
    expiresAt,
  };
}

function parseNetwork(value: string | undefined): Network {
  const network = value ?? defaultNetwork;
  if (!isNetwork(network)) {
    throw new CliError(`unsupported network: ${network}`);
  }
  if (!isSupportedNetwork(network)) {
    throw new CliError(unsupportedNetworkMessage(network));
  }

  return network;
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

function getStdout(dependencies: WalletCommandDependencies): OutputWriter {
  return dependencies.stdout ?? process.stdout;
}

function getNow(dependencies: WalletCommandDependencies): Date {
  return dependencies.now?.() ?? new Date();
}
