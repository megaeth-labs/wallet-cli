import { readFile } from "node:fs/promises";

import { CliError } from "../errors.js";
import type {
  AuthorizedKey,
  CallPermission,
  HexString,
} from "../config/profile.js";
import {
  defaultNetwork,
  getChainConfig,
  type Network,
} from "../config/chains.js";
import {
  assertAllowedCallSignature,
  assertAllowedCallTarget,
} from "../config/callPermissions.js";
import { createEthCallClient, type EthCallClient } from "../eth/client.js";
import { readErc20Metadata } from "../eth/erc20.js";

export type CliPermissionRequest = {
  expiry: number;
  feeToken?: {
    limit: string;
    symbol?: string;
  };
  permissions: AuthorizedKey["permissions"];
};

export type ResolvePermissionsOptions = {
  permissionsFile?: string;
  allowCalls?: string[];
  feeLimit?: string;
  feeToken?: string;
  network?: Network;
  now?: Date;
  spendLimits?: string[];
  tokenMetadataClient?: EthCallClient;
};

const defaultPermissionTtlSeconds = 7 * 24 * 60 * 60;
const defaultFeeLimit = "1";
const defaultUsdmSpendLimit = "100000000000000000000";
const nativeTokenAddress = "0x0000000000000000000000000000000000000000";
const nativeDecimals = 18;
const nativeFeeSymbols = new Set(["eth", "native"]);
type SpendTarget = { decimals: number; symbol: string; token?: HexString };
type SpendPermission = AuthorizedKey["permissions"]["spend"][number];
const extraFeeTokensByNetwork: Partial<
  Record<
    Network,
    Record<string, { token: HexString; decimals: number; symbol: string }>
  >
> = {
  mainnet: {
    usdt0: {
      decimals: 6,
      symbol: "USDT0",
      token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
    },
  },
  testnet: {
    tst: {
      decimals: 6,
      symbol: "TST",
      token: "0x987439Bc4A5A9A2BCEC6354baEB4a1D1011210a1",
    },
  },
};
const selectorPattern = /^0x[0-9a-fA-F]{8}$/;
const periods = new Set(["minute", "hour", "day", "week", "month", "year"]);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const decimalAmountPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export async function resolveKeyPermissions(
  options: ResolvePermissionsOptions = {},
): Promise<CliPermissionRequest> {
  const spendLimits = options.spendLimits ?? [];
  if (options.permissionsFile !== undefined && spendLimits.length > 0) {
    throw new CliError("use either --permissions or --spend-limit, not both");
  }
  if (
    options.permissionsFile !== undefined &&
    (options.feeLimit !== undefined || options.feeToken !== undefined)
  ) {
    throw new CliError(
      "put custom spend and fee settings in the permissions file",
    );
  }

  const allowCalls = options.allowCalls ?? [];
  const request =
    options.permissionsFile === undefined
      ? await resolveDefaultKeyPermissions(options.now, {
          feeLimit: options.feeLimit,
          feeToken: options.feeToken,
          network: options.network,
          spendLimits,
          tokenMetadataClient: options.tokenMetadataClient,
        })
      : parsePermissionRequest(
          JSON.parse(await readFile(options.permissionsFile, "utf8")),
          options.network ?? defaultNetwork,
        );

  const existingCalls =
    options.permissionsFile === undefined
      ? []
      : (request.permissions.calls ?? []);

  const merged =
    allowCalls.length === 0
      ? request
      : {
          ...request,
          permissions: {
            ...request.permissions,
            calls: [...existingCalls, ...allowCalls.map(parseAllowCall)],
          },
        };

  return finalizeKeyPermissions(merged, options.network ?? defaultNetwork);
}

export function defaultKeyPermissions(
  now = new Date(),
  options: Pick<
    ResolvePermissionsOptions,
    "feeLimit" | "feeToken" | "network"
  > = {},
): CliPermissionRequest {
  const network = options.network ?? defaultNetwork;
  const chainConfig = getChainConfig(network);
  const feeToken = resolveFeeSpendTarget(
    options.feeToken ?? chainConfig.defaultFeeToken.symbol,
    network,
  );
  const spend = [defaultSpendPermission(network)];

  return buildDefaultKeyPermissions(now, options, spend, feeToken);
}

async function resolveDefaultKeyPermissions(
  now = new Date(),
  options: Pick<
    ResolvePermissionsOptions,
    "feeLimit" | "feeToken" | "network" | "spendLimits" | "tokenMetadataClient"
  > = {},
): Promise<CliPermissionRequest> {
  const network = options.network ?? defaultNetwork;
  const chainConfig = getChainConfig(network);
  const feeToken = resolveFeeSpendTarget(
    options.feeToken ?? chainConfig.defaultFeeToken.symbol,
    network,
  );
  const spend =
    options.spendLimits !== undefined && options.spendLimits.length > 0
      ? await Promise.all(
          options.spendLimits.map((value) =>
            parseSpendLimitArgument(
              value,
              network,
              options.tokenMetadataClient,
            ),
          ),
        )
      : options.feeLimit !== undefined || options.feeToken !== undefined
        ? []
        : [defaultSpendPermission(network)];

  return buildDefaultKeyPermissions(now, options, spend, feeToken);
}

function buildDefaultKeyPermissions(
  now: Date,
  options: Pick<ResolvePermissionsOptions, "feeLimit">,
  spend: SpendPermission[],
  feeToken: SpendTarget,
): CliPermissionRequest {
  return {
    expiry: Math.floor(now.getTime() / 1000) + defaultPermissionTtlSeconds,
    feeToken: {
      limit: options.feeLimit ?? defaultFeeLimit,
      symbol: feeToken.symbol,
    },
    permissions: {
      calls: [],
      spend,
    },
  };
}

export function normalizeFeeTokenSymbol(
  value: string,
  network: Network = defaultNetwork,
): string {
  const symbol = value.trim();
  if (symbol.length === 0) {
    throw new CliError("fee token must be a non-empty symbol");
  }

  if (nativeFeeSymbols.has(symbol.toLowerCase())) {
    return "ETH";
  }

  const chainConfig = getChainConfig(network);
  if (
    symbol.toLowerCase() === chainConfig.defaultFeeToken.symbol.toLowerCase()
  ) {
    return chainConfig.defaultFeeToken.symbol;
  }

  const extra = extraFeeTokensByNetwork[network]?.[symbol.toLowerCase()];
  if (extra !== undefined) {
    return extra.symbol;
  }

  throw new CliError(
    `unsupported fee token ${symbol}; use ETH, ${chainConfig.defaultFeeToken.symbol}, or another relay-supported fee token for ${chainConfig.name}`,
  );
}

export function encodePermissions(request: CliPermissionRequest): string {
  return Buffer.from(
    JSON.stringify(parsePermissionRequest(request)),
    "utf8",
  ).toString("base64url");
}

export function assertExecutableCallPermission(
  request: CliPermissionRequest,
): void {
  if (
    request.permissions.calls === undefined ||
    request.permissions.calls.length === 0
  ) {
    throw new CliError(
      "permissions.calls must be present and include at least one explicit call permission; relay-backed wallet writes require contract call permission. Use create-key --allow-call <target:signature> or provide permissions.calls entries with both to and signature.",
    );
  }

  for (const call of request.permissions.calls) {
    if (call.to === undefined || call.signature === undefined) {
      throw new CliError(
        "each permissions.calls entry must include both to and signature",
      );
    }
    assertAllowedCallTarget(call.to, "call permission target");
    assertAllowedCallSignature(call.signature, "call permission signature");
  }
}

function resolveFeeSpendTarget(
  value: string,
  network: Network = defaultNetwork,
): SpendTarget {
  const symbol = normalizeFeeTokenSymbol(value, network);
  if (symbol === "ETH") {
    return {
      decimals: nativeDecimals,
      symbol,
    };
  }

  const chainConfig = getChainConfig(network);
  if (
    symbol.toLowerCase() === chainConfig.defaultFeeToken.symbol.toLowerCase()
  ) {
    return {
      decimals: chainConfig.defaultFeeToken.decimals,
      symbol: chainConfig.defaultFeeToken.symbol,
      token: canonicalSpendToken(chainConfig.defaultFeeToken.address),
    };
  }

  const extra = extraFeeTokensByNetwork[network]?.[symbol.toLowerCase()];
  if (extra !== undefined) {
    return {
      ...extra,
      token: canonicalSpendToken(extra.token),
    };
  }

  throw new CliError(`unsupported fee token ${symbol} for ${chainConfig.name}`);
}

function normalizeSpendToken(value: HexString | undefined): string {
  return (value ?? nativeTokenAddress).toLowerCase();
}

function canonicalSpendToken(
  value: HexString | undefined,
): HexString | undefined {
  const token = normalizeSpendToken(value);
  return token === nativeTokenAddress ? undefined : (token as HexString);
}

export function finalizeKeyPermissions(
  request: CliPermissionRequest,
  network: Network = defaultNetwork,
): CliPermissionRequest {
  assertExecutableCallPermission(request);
  return request;
}

export function parsePermissionRequest(
  value: unknown,
  network: Network = defaultNetwork,
): CliPermissionRequest {
  if (!isObject(value)) {
    throw new CliError("permissions must be an object");
  }

  if (
    typeof value.expiry !== "number" ||
    !Number.isSafeInteger(value.expiry) ||
    value.expiry <= 0
  ) {
    throw new CliError("permissions expiry must be a positive integer");
  }

  if (value.maxFeesUSD !== undefined) {
    throw new CliError(
      "permissions maxFeesUSD is not supported; use permissions.spend for fee capacity",
    );
  }

  const feeToken =
    value.feeToken === undefined
      ? undefined
      : parsePermissionFeeToken(value.feeToken, network);
  const permissions = parsePermissionScope(value.permissions);

  const request: CliPermissionRequest = {
    expiry: value.expiry,
    ...(feeToken === undefined ? {} : { feeToken }),
    permissions,
  };

  return request;
}

function parsePermissionFeeToken(
  value: unknown,
  network: Network,
): NonNullable<CliPermissionRequest["feeToken"]> {
  if (!isObject(value)) {
    throw new CliError("permissions feeToken must be an object");
  }

  const rawSymbol =
    value.symbol === undefined
      ? getChainConfig(network).defaultFeeToken.symbol
      : value.symbol;
  if (typeof rawSymbol !== "string" || rawSymbol.length === 0) {
    throw new CliError("permissions feeToken.symbol must be a string");
  }

  const limit = value.limit === undefined ? defaultFeeLimit : value.limit;
  if (typeof limit !== "string" || !decimalAmountPattern.test(limit)) {
    throw new CliError("permissions feeToken.limit must be a decimal string");
  }

  return {
    limit,
    symbol: normalizeFeeTokenSymbol(rawSymbol, network),
  };
}

export function parseAllowCall(value: string): CallPermission {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliError("allow-call must use 0xTarget:signature");
  }

  const to = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  assertAddress(to, "allow-call target must be a 20-byte hex address");
  assertAllowedCallTarget(to, "allow-call target");
  if (signature.length === 0) {
    throw new CliError("allow-call signature is required");
  }
  assertAllowedCallSignature(signature, "allow-call signature");
  assertCallSignatureFormat(
    signature,
    "allow-call signature must be a function signature or 4-byte selector",
  );

  return {
    to: to as HexString,
    signature,
  };
}

export function parsePermissionScope(
  value: unknown,
): AuthorizedKey["permissions"] {
  if (!isObject(value)) {
    throw new CliError("permissions scope must be an object");
  }

  if (!Array.isArray(value.calls)) {
    throw new CliError("permissions.calls must be present and be an array");
  }

  if (!Array.isArray(value.spend)) {
    throw new CliError("permissions spend must be an array");
  }

  const permissions: AuthorizedKey["permissions"] = {
    calls: value.calls.map(parseCallPermission),
    spend: value.spend.map(parseSpendPermission),
  };

  return permissions;
}

function parseCallPermission(value: unknown): CallPermission {
  if (!isObject(value)) {
    throw new CliError("call permission must be an object");
  }

  if (value.to === undefined || value.signature === undefined) {
    throw new CliError(
      "each permissions.calls entry must include both to and signature",
    );
  }

  assertAddress(
    value.to,
    "call permission target must be a 20-byte hex address",
  );
  assertAllowedCallTarget(value.to, "call permission target");
  if (typeof value.signature !== "string" || value.signature.length === 0) {
    throw new CliError("call permission signature is required");
  }
  assertAllowedCallSignature(value.signature, "call permission signature");
  assertCallSignatureFormat(
    value.signature,
    "call permission signature must be a function signature or 4-byte selector",
  );

  return {
    to: value.to,
    signature: value.signature,
  };
}

function assertCallSignatureFormat(value: string, message: string): void {
  if (
    !selectorPattern.test(value) &&
    (!value.includes("(") || !value.endsWith(")"))
  ) {
    throw new CliError(message);
  }
}

function parseSpendPermission(
  value: unknown,
): AuthorizedKey["permissions"]["spend"][number] {
  if (!isObject(value)) {
    throw new CliError("spend permission must be an object");
  }

  const limit = normalizeIntegerString(
    value.limit,
    "spend permission limit is required",
  );
  if (typeof value.period !== "string" || !periods.has(value.period)) {
    throw new CliError("spend permission period is invalid");
  }

  const spend: AuthorizedKey["permissions"]["spend"][number] = {
    limit,
    period:
      value.period as AuthorizedKey["permissions"]["spend"][number]["period"],
  };

  if (value.token !== undefined) {
    assertAddress(
      value.token,
      "spend permission token must be a 20-byte hex address",
    );
    const token = canonicalSpendToken(value.token);
    if (token !== undefined) {
      spend.token = token;
    }
  }

  return spend;
}

function normalizeIntegerString(value: unknown, message: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new CliError(message);
    }
    return value.toString();
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CliError(message);
    }
    return value.toString();
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }

  throw new CliError(message);
}

function defaultSpendPermission(network: Network): SpendPermission {
  return {
    limit: defaultUsdmSpendLimit,
    period: "week",
    token: getChainConfig(network).defaultFeeToken.address,
  };
}

async function parseSpendLimitArgument(
  value: string,
  network: Network,
  client = createEthCallClient(network),
): Promise<SpendPermission> {
  const [token, amount, period, extra] = value.split(":");
  if (
    token === undefined ||
    amount === undefined ||
    period === undefined ||
    extra !== undefined
  ) {
    throw new CliError(
      "--spend-limit must use <token_address>:<amount>:<period>",
    );
  }

  assertAddress(token, "spend-limit token must be a 20-byte hex address");

  const target = await resolveSpendLimitTarget(
    token as HexString,
    network,
    client,
  );

  return {
    limit: normalizeSpendLimitAmount(amount, target),
    period: normalizeSpendPeriod(period),
    ...(target.token === undefined ? {} : { token: target.token }),
  };
}

function normalizeSpendLimitAmount(value: string, target: SpendTarget): string {
  const amount = value.trim();
  if (!decimalAmountPattern.test(amount)) {
    throw new CliError(
      `--spend-limit must be a positive decimal ${target.symbol} amount`,
    );
  }

  const units = decimalToBaseUnits(
    amount,
    target.decimals,
    `--spend-limit must use at most ${target.decimals} decimal places for ${target.symbol}`,
  );
  if (BigInt(units) <= 0n) {
    throw new CliError("--spend-limit must be greater than zero");
  }

  return units;
}

function normalizeSpendPeriod(
  value: string,
): AuthorizedKey["permissions"]["spend"][number]["period"] {
  const period = value.trim();
  if (!periods.has(period)) {
    throw new CliError(
      "spend-limit period must be one of minute, hour, day, week, month, year",
    );
  }

  return period as AuthorizedKey["permissions"]["spend"][number]["period"];
}

async function resolveSpendLimitTarget(
  token: HexString,
  network: Network,
  client = createEthCallClient(network),
): Promise<SpendTarget> {
  const chainConfig = getChainConfig(network);
  if (token.toLowerCase() === nativeTokenAddress) {
    return {
      decimals: nativeDecimals,
      symbol: chainConfig.nativeCurrency.symbol,
    };
  }

  if (
    token.toLowerCase() === chainConfig.defaultFeeToken.address.toLowerCase()
  ) {
    return {
      decimals: chainConfig.defaultFeeToken.decimals,
      symbol: chainConfig.defaultFeeToken.symbol,
      token: canonicalSpendToken(token),
    };
  }

  for (const extra of Object.values(extraFeeTokensByNetwork[network] ?? {})) {
    if (token.toLowerCase() === extra.token.toLowerCase()) {
      return {
        ...extra,
        token: canonicalSpendToken(token),
      };
    }
  }

  try {
    const metadata = await readErc20Metadata(client, token);
    return {
      decimals: metadata.decimals,
      symbol: metadata.symbol ?? token,
      token: canonicalSpendToken(token),
    };
  } catch (error) {
    const reason = error instanceof Error ? ` (${error.message})` : "";
    throw new CliError(
      `could not read spend-limit token ${token} on ${chainConfig.name}${reason}`,
    );
  }
}

function decimalToBaseUnits(
  value: string,
  decimals: number,
  message: string,
): string {
  const amount = value.trim();
  if (!decimalAmountPattern.test(amount)) {
    throw new CliError(message);
  }

  const [whole = "", fraction = ""] = amount.split(".", 2);
  if (fraction.length > decimals) {
    throw new CliError(message);
  }

  const wholePart = whole === "" ? "0" : whole;
  const fractionPart = fraction.padEnd(decimals, "0");
  return `${wholePart}${fractionPart}`.replace(/^0+(?=\d)/, "");
}

function assertAddress(
  value: unknown,
  message: string,
): asserts value is HexString {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    throw new CliError(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
