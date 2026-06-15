import { Command, Option } from "commander";
import { zeroAddress } from "viem";

import { registerCallCommand } from "./call.js";
import {
  assertHttpUrl,
  resolveCommandEnv,
  normalizeNetwork,
  parsePositiveInteger as parsePositiveIntegerValue,
  type ConfigDirCommandOptions,
  type OutputWriter,
} from "./common.js";
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
  openSystemBrowser,
  runLoopbackLogin,
  runLoopbackRevoke,
  type BrowserOpener,
} from "../auth/loopback.js";
import {
  defaultKeyPermissions,
  finalizeKeyPermissions,
  normalizeFeeTokenSymbol,
  resolveKeyPermissions,
  type CliPermissionRequest,
} from "../auth/permissions.js";
import { getChainConfig, type Network } from "../config/chains.js";
import {
  formatTokenAmount,
  summarizeAuthorizedKey,
  tokenLabel,
  type TokenDisplayMetadataMap,
} from "../config/permissionSummary.js";
import {
  addWalletKey,
  deleteWalletProfile,
  findWalletKey,
  getActiveWalletKey,
  isWalletKeyExpired,
  parseWalletProfile,
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
import { createEthCallClient } from "../eth/client.js";
import { readErc20Metadata } from "../eth/erc20.js";
import { CliError } from "../errors.js";
import { compactAddress, formatBulletLines, toJson } from "../output.js";
import { readSpendInfos, type DelegatedSpendInfo } from "../relay/spendInfo.js";
import { renderLoginLogo } from "../terminal/logo.js";
import {
  createTerminalStyle,
  formatTerminalFieldLines,
  type TerminalStyle,
} from "../terminal/style.js";
import {
  updateCli,
  type UpdateDependencies,
  type UpdateResult,
} from "../update.js";

type LoginCommandOptions = ConfigDirCommandOptions & {
  authFlow?: string;
  browser?: boolean;
  network?: string;
  noBrowser?: boolean;
  walletUrl?: string;
  walletApiUrl?: string;
  relayUrl?: string;
  timeoutMs: number;
  json?: boolean;
  terse?: boolean;
};

type CreateKeyCommandOptions = LoginCommandOptions & {
  permissions?: string;
  allowCall: string[];
  feeLimit?: string;
  feeToken?: string;
  from?: string;
  label?: string;
  spendLimit?: string[];
};

type StatusCommandOptions = ConfigDirCommandOptions & {
  network?: string;
  json?: boolean;
  terse?: boolean;
};

type ListCommandOptions = StatusCommandOptions & {
  showInactive?: boolean;
};

type KeyCommandOptions = StatusCommandOptions & {
  authFlow?: string;
  browser?: boolean;
  feeToken?: string;
  noBrowser?: boolean;
  timeoutMs?: number;
  walletUrl?: string;
  walletApiUrl?: string;
};

type LabelCommandOptions = StatusCommandOptions;

type UpdateCommandOptions = {
  check?: boolean;
  json?: boolean;
  terse?: boolean;
  version?: string;
};

type AuthFlow = "loopback";

type TokenMetadataReader = (options: {
  network: Network;
  tokens: readonly HexString[];
}) => Promise<TokenDisplayMetadataMap>;

export type WalletCommandDependencies = {
  authorizeKey?: typeof authorizeLoopbackKey;
  env?: NodeJS.ProcessEnv;
  debug?: DebugCommandDependencies;
  fund?: FundCommandDependencies;
  now?: () => Date;
  openBrowser?: BrowserOpener;
  revokeKey?: typeof runLoopbackRevoke;
  readSpendInfos?: typeof readSpendInfos;
  readTokenMetadata?: TokenMetadataReader;
  stderr?: OutputWriter;
  stdout?: OutputWriter;
  transfer?: TransferCommandDependencies;
  update?: UpdateDependencies;
};

export type WalletStatusResult = ProfileSummary & {
  activeKey?: RenderedWalletKey;
  permissionLines?: string[];
  tokenMetadata?: TokenDisplayMetadataMap;
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
  spendInfoError?: string;
  spendInfos?: DelegatedSpendInfo[];
  tokenMetadata?: TokenDisplayMetadataMap;
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

export type WalletUpdateResult = UpdateResult;

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
    .command("moss")
    .description("Manage MOSS account workflows");

  registerWalletSubcommands(wallet, dependencies);
}

export function registerWalletSubcommands(
  wallet: Command,
  dependencies: WalletCommandDependencies = {},
): void {
  wallet
    .command("login")
    .description("Connect a wallet profile")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .addOption(authFlowOption())
    .option(
      "--no-browser",
      "print authorization instructions without opening a browser",
    )
    .option("--wallet-url <url>", "wallet UI URL")
    .addOption(walletApiUrlOption())
    .option("--relay-url <url>", "MegaETH relay URL")
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
      const stdout = getStdout(dependencies);
      stdout.write(
        renderLogin(profile, options, stdoutStyle(options, dependencies)),
      );
    });

  wallet
    .command("whoami")
    .description("Show the wallet account and selected delegated key")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletWhoami(options, dependencies);
    });

  wallet
    .command("list")
    .description("List local delegated keys")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .option("--show-inactive", "include expired and revoked keys")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: ListCommandOptions) => {
      await runWalletList(options, dependencies);
    });

  wallet
    .command("permissions")
    .description("Show a delegated key permission scope and remaining spend")
    .argument("<key>", "full delegated key id or access address")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (key: string, options: StatusCommandOptions) => {
      await runWalletPermissions(key, options, dependencies);
    });

  wallet
    .command("switch")
    .description("Select the default delegated key for writes")
    .argument("<key>", "delegated key id or access address")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (key: string, options: StatusCommandOptions) => {
      await runWalletSwitch(key, options, dependencies);
    });

  wallet
    .command("create-key")
    .description("Authorize and store a new delegated key")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .addOption(authFlowOption())
    .option(
      "--no-browser",
      "print authorization instructions without opening a browser",
    )
    .option("--wallet-url <url>", "wallet UI URL")
    .addOption(walletApiUrlOption())
    .option("--relay-url <url>", "MegaETH relay URL")
    .option("--from <key>", "copy permissions from an existing key")
    .option("--label <label>", "human-readable key label")
    .option(
      "--spend-limit <token:amount:period>",
      `add spend row; token is a 20-byte address (${zeroAddress} for native ETH), period: minute|hour|day|week|month|year`,
      collectOptional,
    )
    .option(
      "--fee-token <symbol>",
      "deprecated; wallet UI user selects the grant Gas Token",
    )
    .option("--fee-limit <amount>", "maxFeesUSD approval hint for relay fees")
    .option(
      "--permissions <file>",
      "JSON file containing requested permissions",
    )
    .option(
      "--allow-call <target:signature>",
      "allow a target function call; required unless using --permissions or --from",
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
    .addHelpText(
      "afterAll",
      `
Examples:
  mega moss create-key \\
    --spend-limit 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week \\
    --allow-call 0xfafddbb3fc7688494971a79cc65dca3ef82079e7:transfer(address,uint256)

  mega moss create-key \\
    --spend-limit 0x0000000000000000000000000000000000000000:0.01:week \\
    --allow-call 0x4200000000000000000000000000000000000006:deposit()
`,
    )
    .action(async (options: CreateKeyCommandOptions) => {
      await runWalletCreateKey(options, dependencies);
    });

  wallet
    .command("label")
    .description("Set or update a local delegated key label")
    .argument("<key>", "delegated key id or access address")
    .argument("<label>", "human-readable label")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
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
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .addOption(authFlowOption())
    .option(
      "--no-browser",
      "print authorization instructions without opening a browser",
    )
    .option("--wallet-url <url>", "wallet UI URL")
    .addOption(walletApiUrlOption())
    .option(
      "--fee-token <symbol>",
      "relay payment token for this revoke transaction",
    )
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
    .command("update")
    .description("Update the installed MegaETH MOSS CLI and skill")
    .option("--check", "check for an update without installing it")
    .option("--version <version>", "install a specific release tag")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: UpdateCommandOptions) => {
      await runWalletUpdate(options, dependencies);
    });

  wallet
    .command("logout")
    .description("Delete the local wallet profile and key material")
    .option("--network <network>", "wallet network: mainnet or testnet")
    .option("--config-dir <path>", "wallet CLI config directory")
    .option("--json", "render JSON output")
    .option("-t, --terse", "render compact text output")
    .action(async (options: StatusCommandOptions) => {
      await runWalletLogout(options, dependencies);
    });

  registerCallCommand(wallet, {
    env: dependencies.env,
  });
  registerExecuteCommand(wallet, {
    env: dependencies.env,
    stdout: dependencies.stdout,
  });
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
  dependencies: WalletCommandDependencies = {},
): Promise<WalletProfile> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  if (await profileExists(network, env)) {
    const profile = await readWalletProfile(network, env);
    throw new CliError(
      `Wallet already connected to ${compactAddress(profile.accountAddress)}. Either logout with \`mega moss logout\` or add a key to the existing wallet profile with \`mega moss create-key\`.`,
    );
  }

  const chainConfig = getChainConfig(network);
  const walletUrl = options.walletUrl ?? chainConfig.walletUrl;
  const walletApiUrl = options.walletApiUrl ?? chainConfig.walletApiUrl;
  const relayUrl = options.relayUrl ?? chainConfig.relayUrl;
  parseAuthFlow(options.authFlow);

  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  assertHttpUrl(walletApiUrl, "wallet-api-url must be an HTTP(S) URL");
  assertHttpUrl(relayUrl, "relay-url must be an HTTP(S) URL");

  const result = await runLoopbackLogin({
    network,
    walletUrl,
    relayUrl,
    timeoutMs: options.timeoutMs,
    env,
    openBrowser: makeBrowserOpener(options, dependencies, { loginIntro: true }),
  });
  const profile = parseWalletProfile({
    ...result.profile,
    walletApiUrl,
  });
  await writeWalletProfile(profile, env);
  return profile;
}

export async function runWalletWhoami(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletStatusResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  const activeKey = getActiveWalletKey(profile);
  const tokenMetadata =
    activeKey === undefined || options.terse || options.json
      ? {}
      : await loadTokenMetadata([activeKey], undefined, network, dependencies);
  const result = buildStatusResult(
    profile,
    getNow(dependencies),
    tokenMetadata,
  );

  getStdout(dependencies).write(
    renderWhoami(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletList(
  options: ListCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletListResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
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

  getStdout(dependencies).write(
    renderList(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletPermissions(
  selector: string,
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletPermissionsResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  const key = requireWalletKey(profile, selector);
  const renderedKey = renderableKey(profile, key, getNow(dependencies));
  const spendInfoResult = options.terse
    ? {}
    : await loadSpendInfos(profile, key, network, dependencies);
  const tokenMetadata = options.terse
    ? {}
    : await loadTokenMetadata(
        [key],
        spendInfoResult.spendInfos,
        network,
        dependencies,
      );
  const result: WalletPermissionsResult = {
    accountAddress: profile.accountAddress,
    key: renderedKey,
    network,
    permissionLines: summarizeAuthorizedKey(key.authorizedKey, tokenMetadata)
      .lines,
    ...spendInfoResult,
    ...(Object.keys(tokenMetadata).length === 0 ? {} : { tokenMetadata }),
  };

  getStdout(dependencies).write(
    renderPermissions(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

async function loadSpendInfos(
  profile: WalletProfile,
  key: WalletKeyRecord,
  network: Network,
  dependencies: WalletCommandDependencies,
): Promise<Pick<WalletPermissionsResult, "spendInfoError" | "spendInfos">> {
  try {
    const spendInfos = await (dependencies.readSpendInfos ?? readSpendInfos)({
      accountAddress: profile.accountAddress,
      key,
      network,
    });

    return { spendInfos };
  } catch (error) {
    return { spendInfoError: formatSpendInfoError(error) };
  }
}

function formatSpendInfoError(error: unknown): string {
  return formatUnknownError(error).split("\n", 1)[0] ?? "unknown error";
}

async function loadTokenMetadata(
  keys: readonly WalletKeyRecord[],
  spendInfos: readonly DelegatedSpendInfo[] | undefined,
  network: Network,
  dependencies: WalletCommandDependencies,
): Promise<TokenDisplayMetadataMap> {
  const tokens = collectSpendTokens(keys, spendInfos);
  if (tokens.length === 0) {
    return {};
  }

  try {
    return await (
      dependencies.readTokenMetadata ?? readPermissionTokenMetadata
    )({
      network,
      tokens,
    });
  } catch {
    return {};
  }
}

function collectSpendTokens(
  keys: readonly WalletKeyRecord[],
  spendInfos: readonly DelegatedSpendInfo[] | undefined,
): HexString[] {
  const tokens = new Set<HexString>();
  for (const key of keys) {
    for (const spend of key.authorizedKey.permissions.spend) {
      addMetadataToken(tokens, spend.token);
    }
  }
  for (const info of spendInfos ?? []) {
    addMetadataToken(tokens, info.token);
  }

  return [...tokens];
}

function addMetadataToken(
  tokens: Set<HexString>,
  token: HexString | undefined,
): void {
  if (token === undefined || token.toLowerCase() === zeroAddress) {
    return;
  }

  tokens.add(token.toLowerCase() as HexString);
}

async function readPermissionTokenMetadata(options: {
  network: Network;
  tokens: readonly HexString[];
}): Promise<TokenDisplayMetadataMap> {
  const client = createEthCallClient(options.network);
  const entries = await Promise.all(
    options.tokens.map(async (token) => {
      try {
        return [
          token.toLowerCase(),
          await readErc20Metadata(client, token),
        ] as const;
      } catch {
        return undefined;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}

export async function runWalletSwitch(
  selector: string,
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletSwitchResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  const key = requireWalletKey(profile, selector);
  const updated = setActiveWalletKey(profile, key.id, getNow(dependencies));
  await writeWalletProfile(updated, env);
  const active = requireWalletKey(updated, key.id);
  const result: WalletSwitchResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(updated, active, getNow(dependencies)),
    network,
  };

  getStdout(dependencies).write(
    renderSwitch(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletCreateKey(
  options: CreateKeyCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletCreateKeyResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  const chainConfig = getChainConfig(network);
  const walletUrl = options.walletUrl ?? profile.walletUrl;
  const walletApiUrl =
    options.walletApiUrl ?? profile.walletApiUrl ?? chainConfig.walletApiUrl;
  const relayUrl = options.relayUrl ?? profile.relayUrl;
  parseAuthFlow(options.authFlow);
  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");
  assertHttpUrl(walletApiUrl, "wallet-api-url must be an HTTP(S) URL");
  assertHttpUrl(relayUrl, "relay-url must be an HTTP(S) URL");

  const permissionRequest = await resolveCreateKeyPermissions(
    profile,
    options,
    network,
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
    openBrowser: makeBrowserOpener(options, dependencies),
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
      walletApiUrl,
      relayUrl,
    },
    key,
    getNow(dependencies),
  );
  await writeWalletProfile(updated, env);

  const result: WalletCreateKeyResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(
      updated,
      requireWalletKey(updated, key.id),
      getNow(dependencies),
    ),
    network,
  };

  getStdout(dependencies).write(
    renderCreateKey(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletLabel(
  selector: string,
  label: string,
  options: LabelCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletSwitchResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
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
  await writeWalletProfile(updated, env);
  const result: WalletSwitchResult = {
    accountAddress: updated.accountAddress,
    key: renderableKey(
      updated,
      requireWalletKey(updated, key.id),
      getNow(dependencies),
    ),
    network,
  };

  getStdout(dependencies).write(
    renderLabel(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletRevoke(
  selector: string,
  options: KeyCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletRevokeResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  const key = requireWalletKey(profile, selector);
  if (key.status === "revoked") {
    throw new CliError("delegated key is already revoked");
  }

  const walletUrl = options.walletUrl ?? profile.walletUrl;
  parseAuthFlow(options.authFlow);
  assertHttpUrl(walletUrl, "wallet-url must be an HTTP(S) URL");

  const revocation = await (dependencies.revokeKey ?? runLoopbackRevoke)({
    network,
    accountAddress: profile.accountAddress,
    accessAddress: key.accessAddress,
    feeToken: normalizeFeeTokenSymbol(
      options.feeToken ??
        key.authorizedKey.feeToken?.symbol ??
        getChainConfig(network).defaultFeeToken.symbol,
      network,
    ),
    walletUrl,
    timeoutMs: options.timeoutMs,
    openBrowser: makeBrowserOpener(options, dependencies),
  });
  const updated = revokeWalletKeyLocal(profile, key.id, {
    revokeTxHash: revocation.revokeTxHash,
    now: getNow(dependencies),
  });
  await writeWalletProfile(updated, env);

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

  getStdout(dependencies).write(
    renderRevoke(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletLogout(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletLogoutResult> {
  const network = normalizeNetwork(options.network);
  const env = resolveCommandEnv(options, dependencies.env);
  const profile = await readWalletProfile(network, env);
  await deleteWalletProfile(network, env);

  const result: WalletLogoutResult = {
    network,
    accountAddress: profile.accountAddress,
    removed: true,
  };

  getStdout(dependencies).write(
    renderLogout(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

export async function runWalletUpdate(
  options: UpdateCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletUpdateResult> {
  const stderr = getStderr(dependencies);
  const result = await updateCli(
    {
      checkOnly: options.check,
      env: dependencies.env,
      stderr: (chunk) => stderr.write(chunk),
      version: options.version,
    },
    dependencies.update,
  );

  getStdout(dependencies).write(
    renderUpdate(result, options, stdoutStyle(options, dependencies)),
  );

  return result;
}

function renderLogin(
  profile: WalletProfile,
  options: LoginCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(summarizeProfile(profile));
  }

  if (options.terse) {
    return [profile.network, profile.accountAddress].join("\t").concat("\n");
  }

  return [
    style.success("[ok] MOSS wallet connected"),
    "",
    ...formatTerminalFieldLines(
      [
        ["Network", profile.network],
        ["Account", style.accent(profile.accountAddress)],
      ],
      style,
    ),
    "",
    "No delegated key was created. Run mega moss create-key with explicit call scopes before write operations.",
  ]
    .join("\n")
    .concat("\n");
}

function renderWhoami(
  result: WalletStatusResult,
  options: StatusCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    const {
      permissionLines: _permissionLines,
      tokenMetadata: _tokenMetadata,
      ...jsonResult
    } = result;
    return toJson(jsonResult);
  }

  if (result.activeKey === undefined) {
    if (result.keys.length === 0) {
      return [
        style.warning(`No delegated keys for ${result.network}.`),
        "",
        ...formatTerminalFieldLines(
          [
            ["Network", result.network],
            ["Account", style.accent(result.accountAddress)],
          ],
          style,
        ),
        "",
        "Next: mega moss create-key",
      ]
        .join("\n")
        .concat("\n");
    }

    return [
      style.warning(`No usable default delegated key for ${result.network}.`),
      "",
      ...formatTerminalFieldLines(
        [
          ["Network", result.network],
          ["Account", style.accent(result.accountAddress)],
        ],
        style,
      ),
      "",
      "Next: mega moss list --show-inactive, then mega moss switch <key> or mega moss create-key",
    ]
      .join("\n")
      .concat("\n");
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
    ...formatTerminalFieldLines(
      [
        ["Network", result.network],
        ["Account", style.accent(result.accountAddress)],
        ["Delegated key", style.accent(formatKeyLabel(result.activeKey))],
        ["Status", result.activeKey.effectiveStatus],
        ["Expires", result.activeKey.expiresAt],
      ],
      style,
    ),
    "",
    ...(result.permissionLines ??
      summarizeAuthorizedKey(
        result.activeKey.authorizedKey,
        result.tokenMetadata,
      ).lines),
  ];

  if (result.activeKey.expired) {
    lines.unshift(
      style.warning(
        `Warning: delegated key expired at ${result.activeKey.expiresAt}`,
      ),
    );
  }

  return lines.join("\n").concat("\n");
}

function renderList(
  result: WalletListResult,
  options: ListCommandOptions,
  style: TerminalStyle,
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

  const lines = [style.strong(`Delegated keys for ${result.network}:`), ""];
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
    lines.push(
      `- ${style.accent(formatKeyLabel(key))} (${details.join(", ")})`,
    );
  }

  return lines.join("\n").concat("\n");
}

function renderPermissions(
  result: WalletPermissionsResult,
  options: StatusCommandOptions,
  style: TerminalStyle,
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
    style.strong(
      `Permissions for ${style.accent(formatKeyLabel(result.key))}:`,
    ),
    "",
    ...formatTerminalFieldLines(
      [
        ["Status", result.key.effectiveStatus],
        ["Expires", result.key.expiresAt],
      ],
      style,
    ),
    "",
    style.strong("Approved scope (stored request):"),
    ...formatBulletLines(result.permissionLines),
    "",
    ...renderSpendInfoLines(result, style),
  ]
    .join("\n")
    .concat("\n");
}

function renderSpendInfoLines(
  result: WalletPermissionsResult,
  style: TerminalStyle,
): string[] {
  if (result.spendInfoError !== undefined) {
    return [
      style.strong("Live on-chain spend remaining:"),
      ...formatBulletLines([`unavailable (${result.spendInfoError})`]),
    ];
  }

  if (result.spendInfos === undefined) {
    return [];
  }

  if (result.spendInfos.length === 0) {
    return [
      style.strong("Live on-chain spend remaining:"),
      ...formatBulletLines(["no spend limits found"]),
    ];
  }

  return [
    style.strong("Live on-chain spend remaining:"),
    ...formatBulletLines(
      result.spendInfos.map((info) => {
        const token = spendInfoTokenLabel(info, result.tokenMetadata);
        const remaining = formatSpendInfoAmount(
          info.remaining,
          info,
          result.tokenMetadata,
        );
        const currentSpent = formatSpendInfoAmount(
          info.currentSpent,
          info,
          result.tokenMetadata,
        );
        const limit = formatSpendInfoAmount(
          info.limit,
          info,
          result.tokenMetadata,
        );

        return `${remaining} ${token} remaining for current ${info.period} (${currentSpent} of ${limit} spent)`;
      }),
    ),
  ];
}

function formatSpendInfoAmount(
  value: string,
  info: DelegatedSpendInfo,
  tokenMetadata: TokenDisplayMetadataMap = {},
): string {
  return formatTokenAmount(value, spendInfoToken(info), tokenMetadata);
}

function spendInfoTokenLabel(
  info: DelegatedSpendInfo,
  tokenMetadata: TokenDisplayMetadataMap = {},
): string {
  return tokenLabel(spendInfoToken(info), tokenMetadata);
}

function spendInfoToken(info: DelegatedSpendInfo): HexString | undefined {
  return info.token.toLowerCase() === zeroAddress
    ? undefined
    : (info.token as HexString);
}

function renderSwitch(
  result: WalletSwitchResult,
  options: StatusCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id].join("\t").concat("\n");
  }

  return [
    style.success("Default delegated key set."),
    "",
    `${style.dim("Delegated key")}: ${style.accent(formatKeyLabel(result.key))}`,
    "",
  ].join("\n");
}

function renderCreateKey(
  result: WalletCreateKeyResult,
  options: CreateKeyCommandOptions,
  style: TerminalStyle,
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
    style.success(`Created delegated key ${formatKeyLabel(result.key)}.`),
    "",
    ...formatTerminalFieldLines(
      [
        ["Access address", style.accent(result.key.accessAddress)],
        ["Network", result.network],
      ],
      style,
    ),
    "",
    "This key is now the default for write operations.",
    `Next: mega moss permissions ${result.key.accessAddress}`,
  ]
    .join("\n")
    .concat("\n");
}

function renderLabel(
  result: WalletSwitchResult,
  options: StatusCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id, result.key.label ?? ""]
      .join("\t")
      .concat("\n");
  }

  return [
    style.success("Updated delegated key label."),
    "",
    `${style.dim("Delegated key")}: ${style.accent(formatKeyLabel(result.key))}`,
    "",
  ].join("\n");
}

function renderRevoke(
  result: WalletRevokeResult,
  options: KeyCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(result);
  }
  if (options.terse) {
    return [result.network, result.key.id, "revoked", result.revokeTxHash ?? ""]
      .join("\t")
      .concat("\n");
  }

  const lines = [
    style.success(`Revoked delegated key ${formatKeyLabel(result.key)}.`),
  ];
  if (result.revokeTxHash !== undefined) {
    lines.push("");
    lines.push(
      `${style.dim("Transaction")}: ${style.accent(result.revokeTxHash)}`,
    );
  }

  return lines.join("\n").concat("\n");
}

function renderLogout(
  result: WalletLogoutResult,
  options: StatusCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return [result.network, "removed"].join("\t").concat("\n");
  }

  return [
    style.warning(`Removed ${result.network} wallet profile.`),
    "",
    ...formatTerminalFieldLines(
      [["Account", style.accent(result.accountAddress)]],
      style,
    ),
    "",
    "Deleted local delegated key material.",
    "Delegated keys were not revoked on-chain.",
  ]
    .join("\n")
    .concat("\n");
}

function renderUpdate(
  result: WalletUpdateResult,
  options: UpdateCommandOptions,
  style: TerminalStyle,
): string {
  if (options.json) {
    return toJson(result);
  }

  if (options.terse) {
    return [
      result.currentVersion,
      result.latestVersion,
      result.updateAvailable ? "available" : "current",
      result.updated ? "updated" : "not-updated",
    ]
      .join("\t")
      .concat("\n");
  }

  if (result.updated) {
    return [
      style.success("Updated MegaETH MOSS CLI."),
      "",
      ...formatTerminalFieldLines(
        [
          ["Previous", result.currentVersion],
          ["Current", style.accent(result.latestVersion)],
        ],
        style,
      ),
      "",
      "Restart any long-running shell sessions before relying on the new version.",
    ]
      .join("\n")
      .concat("\n");
  }

  if (result.updateAvailable) {
    return [
      style.warning("Update available."),
      "",
      ...formatTerminalFieldLines(
        [
          ["Current", result.currentVersion],
          ["Latest", style.accent(result.latestVersion)],
        ],
        style,
      ),
      "",
      "Run: mega moss update",
    ]
      .join("\n")
      .concat("\n");
  }

  return [
    style.success("MegaETH MOSS CLI is up to date."),
    "",
    `${style.dim("Version")}: ${style.accent(result.currentVersion)}`,
  ]
    .join("\n")
    .concat("\n");
}

function buildStatusResult(
  profile: WalletProfile,
  now: Date,
  tokenMetadata: TokenDisplayMetadataMap = {},
): WalletStatusResult {
  const activeKey = getActiveWalletKey(profile);
  const summary = summarizeProfile(profile);

  return {
    ...summary,
    ...(activeKey === undefined
      ? {}
      : {
          activeKey: renderableKey(profile, activeKey, now),
          permissionLines: summarizeAuthorizedKey(
            activeKey.authorizedKey,
            tokenMetadata,
          ).lines,
        }),
    ...(Object.keys(tokenMetadata).length === 0 ? {} : { tokenMetadata }),
  };
}

async function resolveCreateKeyPermissions(
  profile: WalletProfile,
  options: CreateKeyCommandOptions,
  network: Network,
  now: Date,
): Promise<CliPermissionRequest> {
  const spendLimits = options.spendLimit ?? [];
  const usesExplicitPermissions =
    options.permissions !== undefined ||
    options.allowCall.length > 0 ||
    options.feeLimit !== undefined ||
    options.feeToken !== undefined ||
    spendLimits.length > 0;
  if (options.from !== undefined && usesExplicitPermissions) {
    throw new CliError(
      "use either --from or explicit permission options, not both",
    );
  }
  if (options.permissions !== undefined && spendLimits.length > 0) {
    throw new CliError("use either --permissions or --spend-limit, not both");
  }
  if (
    options.permissions !== undefined &&
    (options.feeLimit !== undefined || options.feeToken !== undefined)
  ) {
    throw new CliError(
      "put custom spend and fee settings in the permissions file",
    );
  }

  if (options.from !== undefined) {
    const source = requireWalletKey(profile, options.from);
    const fallback = defaultKeyPermissions(now, { network });

    return finalizeKeyPermissions(
      {
        expiry: fallback.expiry,
        maxFeesUSD: fallback.maxFeesUSD,
        permissions: source.authorizedKey.permissions,
      },
      network,
    );
  }

  return resolveKeyPermissions({
    permissionsFile: options.permissions,
    allowCalls: options.allowCall,
    feeLimit: options.feeLimit,
    feeToken: options.feeToken,
    network,
    spendLimits,
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

  return `${key.accessAddress}${label}`;
}

function sameKey(left: WalletKeyRecord, right: WalletKeyRecord): boolean {
  return left.id.toLowerCase() === right.id.toLowerCase();
}

function parseAuthFlow(value: string | undefined): AuthFlow {
  const flow = value ?? "loopback";
  if (flow !== "loopback") {
    throw new CliError(
      "device-code auth is not supported right now; use same-machine loopback auth",
    );
  }

  return flow;
}

function authFlowOption(): Option {
  return new Option(
    "--auth-flow <flow>",
    "unsupported; only loopback auth is available",
  ).hideHelp();
}

function walletApiUrlOption(): Option {
  return new Option("--wallet-api-url <url>", "wallet API URL").hideHelp();
}

function parsePositiveInteger(value: string): number {
  return parsePositiveIntegerValue(
    value,
    "timeout-ms must be a positive integer",
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectOptional(
  value: string,
  previous: string[] | undefined,
): string[] {
  return [...(previous ?? []), value];
}

function makeBrowserOpener(
  options: { json?: boolean; noBrowser?: boolean; terse?: boolean },
  dependencies: WalletCommandDependencies,
  renderOptions: { loginIntro?: boolean } = {},
): BrowserOpener {
  const opener = dependencies.openBrowser ?? openSystemBrowser;
  return async (url) => {
    const shouldOpen = shouldOpenBrowser(options);
    if (renderOptions.loginIntro && !options.json && !options.terse) {
      const stderr = getStderr(dependencies);
      const style = stderrStyle(options, dependencies);
      await renderLoginLogo({
        env: dependencies.env,
        stream: stderr,
      });
      if (shouldOpen) {
        stderr.write(`${style.success("Opening MegaETH Wallet...")}\n\n`);
      }
    }

    if (!shouldOpen) {
      getStderr(dependencies).write(`Open this URL to authorize: ${url}\n`);
      return;
    }

    await opener(url);
  };
}

function shouldOpenBrowser(options: {
  browser?: boolean;
  noBrowser?: boolean;
}): boolean {
  return options.noBrowser !== true && options.browser !== false;
}

function getStdout(dependencies: WalletCommandDependencies): OutputWriter {
  return dependencies.stdout ?? process.stdout;
}

function getStderr(dependencies: WalletCommandDependencies): OutputWriter {
  return dependencies.stderr ?? process.stderr;
}

function stdoutStyle(
  options: { json?: boolean; terse?: boolean },
  dependencies: WalletCommandDependencies,
): TerminalStyle {
  return createTerminalStyle({
    env: dependencies.env,
    json: options.json,
    stream: getStdout(dependencies),
    terse: options.terse,
  });
}

function stderrStyle(
  options: { json?: boolean; terse?: boolean },
  dependencies: WalletCommandDependencies,
): TerminalStyle {
  return createTerminalStyle({
    env: dependencies.env,
    json: options.json,
    stream: getStderr(dependencies),
    terse: options.terse,
  });
}

function getNow(dependencies: WalletCommandDependencies): Date {
  return dependencies.now?.() ?? new Date();
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
