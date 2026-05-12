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
  authorizeLoopbackKey,
  runLoopbackLogin,
  runLoopbackRevoke,
} from "../auth/loopback.js";
import {
  defaultLoginPermissions,
  resolveLoginPermissions,
  type CliPermissionRequest,
} from "../auth/permissions.js";
import {
  defaultNetwork,
  getChainConfig,
  isNetwork,
  isSupportedNetwork,
  type Network,
  unsupportedNetworkMessage,
} from "../config/chains.js";
import { summarizeAuthorizedKey } from "../config/permissionSummary.js";
import {
  addWalletKey,
  deleteWalletProfile,
  findWalletKey,
  getActiveWalletKey,
  isWalletKeyExpired,
  profileExists,
  readWalletProfile,
  revokeWalletKeyLocal,
  setActiveWalletKey,
  summarizeProfile,
  writeWalletProfile,
  type HexString,
  type ProfileSummary,
  type WalletKeyRecord,
  type WalletKeySummary,
  type WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import { compactAddress, toJson } from "../output.js";

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

type CreateKeyCommandOptions = LoginCommandOptions & {
  from?: string;
  label?: string;
  spendLimit?: string;
};

type StatusCommandOptions = {
  network?: string;
  json?: boolean;
  terse?: boolean;
};

type ListCommandOptions = StatusCommandOptions & {
  showInactive?: boolean;
};

type KeyCommandOptions = StatusCommandOptions & {
  timeoutMs?: number;
  walletUrl?: string;
};

type LabelCommandOptions = StatusCommandOptions;

type OutputWriter = {
  write(chunk: string): unknown;
};

export type WalletCommandDependencies = {
  authorizeKey?: typeof authorizeLoopbackKey;
  env?: NodeJS.ProcessEnv;
  debug?: DebugCommandDependencies;
  fund?: FundCommandDependencies;
  now?: () => Date;
  revokeKey?: typeof runLoopbackRevoke;
  stdout?: OutputWriter;
  transfer?: TransferCommandDependencies;
};

export type WalletStatusResult = ProfileSummary & {
  activeKey?: RenderedWalletKey;
};

export type WalletListResult = {
  accountAddress: HexString;
  activeKeyId?: HexString;
  keys: RenderedWalletKey[];
  network: Network;
};

export type WalletPermissionsResult = {
  accountAddress: HexString;
  key: RenderedWalletKey;
  network: Network;
  permissionLines: string[];
};

export type WalletSwitchResult = {
  accountAddress: HexString;
  key: RenderedWalletKey;
  network: Network;
};

export type WalletCreateKeyResult = {
  accountAddress: HexString;
  key: RenderedWalletKey;
  network: Network;
};

export type WalletRevokeResult = {
  accountAddress: HexString;
  key: RenderedWalletKey;
  network: Network;
  revokeTxHash?: HexString;
};

export type WalletLogoutResult = {
  network: Network;
  accountAddress: HexString;
  removed: boolean;
};

export type RenderedWalletKey = WalletKeySummary & {
  active: boolean;
  expired: boolean;
  expiresAt: string;
  effectiveStatus: "active" | "expired" | "revoked";
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
    .description("Connect a wallet profile")
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
      const profile = await login(options, dependencies);
      getStdout(dependencies).write(renderLogin(profile, options));
    });

  wallet
    .command("whoami")
    .description("Show the wallet account and selected delegated key")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletWhoami(options, dependencies);
    });

  wallet
    .command("list")
    .description("List local delegated keys")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--show-inactive", "include expired and revoked keys")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: ListCommandOptions) => {
      await runWalletList(options, dependencies);
    });

  wallet
    .command("permissions")
    .description("Show a delegated key permission scope")
    .argument("<key>", "delegated key id or access address")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (key: string, options: StatusCommandOptions) => {
      await runWalletPermissions(key, options, dependencies);
    });

  wallet
    .command("switch")
    .description("Select the default delegated key for writes")
    .argument("<key>", "delegated key id or access address")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (key: string, options: StatusCommandOptions) => {
      await runWalletSwitch(key, options, dependencies);
    });

  wallet
    .command("create-key")
    .description("Authorize and store a new delegated key")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--wallet-url <url>", "wallet UI URL")
    .option("--relay-url <url>", "MegaETH relay URL")
    .option("--from <key>", "copy permissions from an existing key")
    .option("--label <label>", "human-readable key label")
    .option(
      "--spend-limit <amount>",
      "USDM spend cap for the default permission request",
    )
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
    .action(async (options: CreateKeyCommandOptions) => {
      await runWalletCreateKey(options, dependencies);
    });

  wallet
    .command("label")
    .description("Set or update a local delegated key label")
    .argument("<key>", "delegated key id or access address")
    .argument("<label>", "human-readable label")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(
      async (key: string, label: string, options: LabelCommandOptions) => {
        await runWalletLabel(key, label, options, dependencies);
      },
    );

  wallet
    .command("revoke")
    .description("Revoke a delegated key on-chain and keep an audit record")
    .argument("<key>", "delegated key id or access address")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--wallet-url <url>", "wallet UI URL")
    .option(
      "--timeout-ms <ms>",
      "loopback revocation timeout",
      parsePositiveInteger,
      120_000,
    )
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (key: string, options: KeyCommandOptions) => {
      await runWalletRevoke(key, options, dependencies);
    });

  wallet
    .command("logout")
    .description("Delete the local wallet profile and key material")
    .option("--network <network>", "wallet network", defaultNetwork)
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletLogout(options, dependencies);
    });

  registerCallCommand(wallet, {
    env: dependencies.env,
  });
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
  dependencies: Pick<WalletCommandDependencies, "env"> = {},
): Promise<WalletProfile> {
  const network = parseNetwork(options.network);
  if (await profileExists(network, dependencies.env)) {
    const profile = await readWalletProfile(network, dependencies.env);
    throw new CliError(
      `Wallet already connected to ${compactAddress(profile.accountAddress)}. Either logout with \`mega wallet logout\` or add a key to the existing wallet profile with \`mega wallet create-key\`.`,
    );
  }

  const chainConfig = getChainConfig(network);
  const walletUrl = options.walletUrl ?? chainConfig.walletUrl;
  const relayUrl = options.relayUrl ?? chainConfig.relayUrl;

  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  assertHttpUrl(relayUrl, "relay-url must be an HTTP(S) URL");

  const permissionRequest = await resolveLoginPermissions({
    permissionsFile: options.permissions,
    allowCalls: options.allowCall,
  });

  return (
    await runLoopbackLogin({
      network,
      permissionRequest,
      walletUrl,
      relayUrl,
      timeoutMs: options.timeoutMs,
      env: dependencies.env,
    })
  ).profile;
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

export async function runWalletList(
  options: ListCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletListResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const now = getNow(dependencies);
  const keys = sortKeysByRecency(profile.keys)
    .map((key) => renderableKey(profile, key, now))
    .filter(
      (key) =>
        options.showInactive ||
        (key.effectiveStatus === "active" && key.status === "active"),
    );
  const result: WalletListResult = {
    accountAddress: profile.accountAddress,
    ...(profile.activeKeyId === undefined
      ? {}
      : { activeKeyId: profile.activeKeyId }),
    keys,
    network,
  };

  getStdout(dependencies).write(renderList(result, options));

  return result;
}

export async function runWalletPermissions(
  selector: string,
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletPermissionsResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const key = requireWalletKey(profile, selector);
  const renderedKey = renderableKey(profile, key, getNow(dependencies));
  const result: WalletPermissionsResult = {
    accountAddress: profile.accountAddress,
    key: renderedKey,
    network,
    permissionLines: summarizeAuthorizedKey(key.authorizedKey).lines,
  };

  getStdout(dependencies).write(renderPermissions(result, options));

  return result;
}

export async function runWalletSwitch(
  selector: string,
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletSwitchResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const key = requireWalletKey(profile, selector);
  const updated = setActiveWalletKey(profile, key.id, getNow(dependencies));
  await writeWalletProfile(updated, dependencies.env);
  const active = requireWalletKey(updated, key.id);
  const result: WalletSwitchResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(updated, active, getNow(dependencies)),
    network,
  };

  getStdout(dependencies).write(renderSwitch(result, options));

  return result;
}

export async function runWalletCreateKey(
  options: CreateKeyCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletCreateKeyResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const walletUrl = options.walletUrl ?? profile.walletUrl;
  const relayUrl = options.relayUrl ?? profile.relayUrl;
  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  assertHttpUrl(relayUrl, "relay-url must be an HTTP(S) URL");

  const permissionRequest = await resolveCreateKeyPermissions(
    profile,
    options,
    getNow(dependencies),
  );
  const authorization = await (
    dependencies.authorizeKey ?? authorizeLoopbackKey
  )({
    network,
    permissionRequest,
    walletUrl,
    relayUrl,
    timeoutMs: options.timeoutMs,
  });

  if (
    authorization.accountAddress.toLowerCase() !==
    profile.accountAddress.toLowerCase()
  ) {
    throw new CliError(
      "authorized wallet account does not match local profile",
    );
  }

  const key: WalletKeyRecord = {
    ...authorization.key,
    ...(options.label === undefined ? {} : { label: options.label }),
  };
  const updated = addWalletKey(
    {
      ...profile,
      walletUrl,
      relayUrl,
    },
    key,
    getNow(dependencies),
  );
  await writeWalletProfile(updated, dependencies.env);

  const result: WalletCreateKeyResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(
      updated,
      requireWalletKey(updated, key.id),
      getNow(dependencies),
    ),
    network,
  };

  getStdout(dependencies).write(renderCreateKey(result, options));

  return result;
}

export async function runWalletLabel(
  selector: string,
  label: string,
  options: LabelCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletSwitchResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const key = requireWalletKey(profile, selector);
  if (label.trim().length === 0) {
    throw new CliError("label must not be empty");
  }

  const timestamp = getNow(dependencies).toISOString();
  const updated = {
    ...profile,
    keys: profile.keys.map((entry) =>
      sameKey(entry, key)
        ? { ...entry, label: label.trim(), updatedAt: timestamp }
        : entry,
    ),
    updatedAt: timestamp,
  };
  await writeWalletProfile(updated, dependencies.env);
  const result: WalletSwitchResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(
      updated,
      requireWalletKey(updated, key.id),
      getNow(dependencies),
    ),
    network,
  };

  getStdout(dependencies).write(renderLabel(result, options));

  return result;
}

export async function runWalletRevoke(
  selector: string,
  options: KeyCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletRevokeResult> {
  const network = parseNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const key = requireWalletKey(profile, selector);
  if (key.status === "revoked") {
    throw new CliError("delegated key is already revoked");
  }

  const revocation = await (dependencies.revokeKey ?? runLoopbackRevoke)({
    network,
    accountAddress: profile.accountAddress,
    accessAddress: key.accessAddress,
    walletUrl: options.walletUrl ?? profile.walletUrl,
    timeoutMs: options.timeoutMs,
  });
  const updated = revokeWalletKeyLocal(profile, key.id, {
    revokeTxHash: revocation.revokeTxHash,
    now: getNow(dependencies),
  });
  await writeWalletProfile(updated, dependencies.env);

  const result: WalletRevokeResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(
      updated,
      requireWalletKey(updated, key.id),
      getNow(dependencies),
    ),
    network,
    ...(revocation.revokeTxHash === undefined
      ? {}
      : { revokeTxHash: revocation.revokeTxHash }),
  };

  getStdout(dependencies).write(renderRevoke(result, options));

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
    removed: true,
  };

  getStdout(dependencies).write(renderLogout(result, options));

  return result;
}

function renderLogin(
  profile: WalletProfile,
  options: LoginCommandOptions,
): string {
  const activeKey = getActiveWalletKey(profile);
  if (activeKey === undefined) {
    throw new CliError("wallet login did not create an active delegated key");
  }

  if (options.json) {
    return toJson(summarizeProfile(profile));
  }

  const expiry = new Date(activeKey.authorizedKey.expiry * 1000).toISOString();
  if (options.terse) {
    return [
      profile.network,
      profile.accountAddress,
      activeKey.accessAddress,
      activeKey.authorizedKey.expiry.toString(),
    ]
      .join("\t")
      .concat("\n");
  }

  return [
    `Logged in to ${profile.network}.`,
    `Account: ${compactAddress(profile.accountAddress)}`,
    `Delegated key: ${compactAddress(activeKey.accessAddress)}`,
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

  if (result.activeKey === undefined) {
    return `No active delegated key for ${result.network}.\n`;
  }

  if (options.terse) {
    return [
      result.network,
      result.accountAddress,
      result.activeKey.accessAddress,
      result.activeKey.effectiveStatus,
      result.activeKey.authorizedKey.expiry.toString(),
    ]
      .join("\t")
      .concat("\n");
  }

  const lines = [
    `Network: ${result.network}`,
    `Account: ${compactAddress(result.accountAddress)}`,
    `Delegated key: ${formatKeyLabel(result.activeKey)}`,
    `Status: ${result.activeKey.effectiveStatus}`,
    `Expires: ${result.activeKey.expiresAt}`,
    ...summarizeAuthorizedKey(result.activeKey.authorizedKey).lines,
  ];

  if (result.activeKey.expired) {
    lines.unshift(
      `Warning: delegated key expired at ${result.activeKey.expiresAt}`,
    );
  }

  return lines.join("\n").concat("\n");
}

function renderList(
  result: WalletListResult,
  options: ListCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return result.keys
      .map((key) =>
        [
          result.network,
          key.id,
          key.accessAddress,
          key.effectiveStatus,
          key.active ? "default" : "",
          key.authorizedKey.expiry.toString(),
          key.label ?? "",
        ].join("\t"),
      )
      .join("\n")
      .concat(result.keys.length > 0 ? "\n" : "");
  }

  const lines = [`Delegated keys for ${result.network}:`];
  if (result.keys.length === 0) {
    lines.push(
      "No active delegated keys. Use --show-inactive to include expired or revoked keys.",
    );
    return lines.join("\n").concat("\n");
  }

  for (const key of result.keys) {
    const details = [
      key.effectiveStatus,
      key.active ? "default" : undefined,
      `expires ${key.expiresAt}`,
    ].filter(Boolean);
    lines.push(`- ${formatKeyLabel(key)} (${details.join(", ")})`);
  }

  return lines.join("\n").concat("\n");
}

function renderPermissions(
  result: WalletPermissionsResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return [
      result.network,
      result.key.id,
      result.key.effectiveStatus,
      result.key.authorizedKey.expiry.toString(),
    ]
      .join("\t")
      .concat("\n");
  }

  return [
    `Permissions for ${formatKeyLabel(result.key)}:`,
    `Status: ${result.key.effectiveStatus}`,
    `Expires: ${result.key.expiresAt}`,
    ...result.permissionLines,
  ]
    .join("\n")
    .concat("\n");
}

function renderSwitch(
  result: WalletSwitchResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id].join("\t").concat("\n");
  }

  return `Default delegated key set to ${formatKeyLabel(result.key)}.\n`;
}

function renderCreateKey(
  result: WalletCreateKeyResult,
  options: CreateKeyCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id, result.key.accessAddress]
      .join("\t")
      .concat("\n");
  }

  return [
    `Created delegated key ${formatKeyLabel(result.key)}.`,
    "This key is now the default for write operations.",
  ]
    .join("\n")
    .concat("\n");
}

function renderLabel(
  result: WalletSwitchResult,
  options: StatusCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id, result.key.label ?? ""]
      .join("\t")
      .concat("\n");
  }

  return `Updated label for ${formatKeyLabel(result.key)}.\n`;
}

function renderRevoke(
  result: WalletRevokeResult,
  options: KeyCommandOptions,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id, "revoked", result.revokeTxHash ?? ""]
      .join("\t")
      .concat("\n");
  }

  const lines = [`Revoked delegated key ${formatKeyLabel(result.key)}.`];
  if (result.revokeTxHash !== undefined) {
    lines.push(`Transaction: ${result.revokeTxHash}`);
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
    return [result.network, "removed"].join("\t").concat("\n");
  }

  return [
    `Removed ${result.network} wallet profile.`,
    `Account: ${compactAddress(result.accountAddress)}`,
    "Deleted local delegated key material.",
    "Delegated keys were not revoked on-chain.",
  ]
    .join("\n")
    .concat("\n");
}

function buildStatusResult(
  profile: WalletProfile,
  now: Date,
): WalletStatusResult {
  const activeKey = getActiveWalletKey(profile);
  const summary = summarizeProfile(profile);

  return {
    ...summary,
    ...(activeKey === undefined
      ? {}
      : { activeKey: renderableKey(profile, activeKey, now) }),
  };
}

async function resolveCreateKeyPermissions(
  profile: WalletProfile,
  options: CreateKeyCommandOptions,
  now: Date,
): Promise<CliPermissionRequest> {
  const usesExplicitPermissions =
    options.permissions !== undefined ||
    options.allowCall.length > 0 ||
    options.spendLimit !== undefined;
  if (options.from !== undefined && usesExplicitPermissions) {
    throw new CliError(
      "use either --from or explicit permission options, not both",
    );
  }
  if (options.permissions !== undefined && options.spendLimit !== undefined) {
    throw new CliError("use either --permissions or --spend-limit, not both");
  }

  if (options.from !== undefined) {
    const source = requireWalletKey(profile, options.from);
    const fallback = defaultLoginPermissions(now);

    return {
      expiry: fallback.expiry,
      feeToken: source.authorizedKey.feeToken ?? fallback.feeToken,
      permissions: source.authorizedKey.permissions,
    };
  }

  return resolveLoginPermissions({
    permissionsFile: options.permissions,
    allowCalls: options.allowCall,
    spendLimit: options.spendLimit,
    now,
  });
}

function requireWalletKey(
  profile: WalletProfile,
  selector: string,
): WalletKeyRecord {
  const key = findWalletKey(profile, selector);
  if (key === undefined) {
    throw new CliError(`delegated key not found: ${selector}`);
  }

  return key;
}

function renderableKey(
  profile: WalletProfile,
  key: WalletKeyRecord,
  now: Date,
): RenderedWalletKey {
  const expired = isWalletKeyExpired(key, now);
  const active =
    profile.activeKeyId !== undefined &&
    key.id.toLowerCase() === profile.activeKeyId.toLowerCase();
  const summary = summarizeProfile({
    ...profile,
    keys: [key],
  }).keys[0]!;

  return {
    ...summary,
    active,
    expired,
    expiresAt: new Date(key.authorizedKey.expiry * 1000).toISOString(),
    effectiveStatus:
      key.status === "revoked" ? "revoked" : expired ? "expired" : "active",
  };
}

function sortKeysByRecency(
  keys: readonly WalletKeyRecord[],
): WalletKeyRecord[] {
  return [...keys].sort(
    (left, right) => keyTimestamp(right) - keyTimestamp(left),
  );
}

function keyTimestamp(key: WalletKeyRecord): number {
  return Date.parse(key.lastUsedAt ?? key.updatedAt ?? key.createdAt);
}

function formatKeyLabel(key: RenderedWalletKey): string {
  const label = key.label === undefined ? "" : ` "${key.label}"`;

  return `${compactAddress(key.accessAddress)}${label}`;
}

function sameKey(left: WalletKeyRecord, right: WalletKeyRecord): boolean {
  return left.id.toLowerCase() === right.id.toLowerCase();
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
