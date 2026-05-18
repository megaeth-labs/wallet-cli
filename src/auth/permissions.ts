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

export type CliPermissionRequest = {
  expiry: number;
  feeToken: {
    limit: string;
    symbol?: string;
  };
  maxFeesUSD?: number;
  permissions: AuthorizedKey["permissions"];
};

export type ResolvePermissionsOptions = {
  permissionsFile?: string;
  allowCalls?: string[];
  network?: Network;
  now?: Date;
  spendLimit?: string;
};

const defaultPermissionTtlSeconds = 7 * 24 * 60 * 60;
const defaultFeeTokenLimit = "1";
const defaultUsdmSpendLimit = "100000000000000000000";
const usdmDecimals = 18;
const selectorPattern = /^0x[0-9a-fA-F]{8}$/;
const periods = new Set(["minute", "hour", "day", "week", "month", "year"]);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const decimalAmountPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export async function resolveLoginPermissions(
  options: ResolvePermissionsOptions = {},
): Promise<CliPermissionRequest> {
  if (
    options.permissionsFile !== undefined &&
    options.spendLimit !== undefined
  ) {
    throw new CliError("use either --permissions or --spend-limit, not both");
  }

  const request =
    options.permissionsFile === undefined
      ? defaultLoginPermissions(options.now, {
          network: options.network,
          spendLimit: options.spendLimit,
        })
      : parsePermissionRequest(
          JSON.parse(await readFile(options.permissionsFile, "utf8")),
        );

  const allowCalls = options.allowCalls ?? [];
  if (allowCalls.length === 0) {
    return request;
  }

  const existingCalls =
    options.permissionsFile === undefined
      ? []
      : (request.permissions.calls ?? []);

  return {
    ...request,
    permissions: {
      ...request.permissions,
      calls: [...existingCalls, ...allowCalls.map(parseAllowCall)],
    },
  };
}

export function defaultLoginPermissions(
  now = new Date(),
  options: Pick<ResolvePermissionsOptions, "network" | "spendLimit"> = {},
): CliPermissionRequest {
  const chainConfig = getChainConfig(options.network ?? defaultNetwork);

  return {
    expiry: Math.floor(now.getTime() / 1000) + defaultPermissionTtlSeconds,
    feeToken: {
      limit: defaultFeeTokenLimit,
      symbol: chainConfig.defaultFeeToken.symbol,
    },
    permissions: {
      calls: [{}],
      spend: [
        {
          limit: normalizeDefaultUsdmSpendLimit(options.spendLimit),
          period: "year",
          token: chainConfig.defaultFeeToken.address,
        },
      ],
    },
  };
}

export function encodePermissions(request: CliPermissionRequest): string {
  return Buffer.from(
    JSON.stringify(parsePermissionRequest(request)),
    "utf8",
  ).toString("base64url");
}

export function parsePermissionRequest(value: unknown): CliPermissionRequest {
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

  if (!isObject(value.feeToken)) {
    throw new CliError("permissions feeToken must be an object");
  }

  const feeLimit = normalizeDecimalString(
    value.feeToken.limit,
    "permissions feeToken.limit is required",
  );
  const feeToken: CliPermissionRequest["feeToken"] = {
    limit: feeLimit,
  };
  if (value.feeToken.symbol !== undefined) {
    if (
      typeof value.feeToken.symbol !== "string" ||
      value.feeToken.symbol.length === 0
    ) {
      throw new CliError("permissions feeToken.symbol must be a string");
    }
    feeToken.symbol = value.feeToken.symbol;
  }

  const request: CliPermissionRequest = {
    expiry: value.expiry,
    feeToken,
    permissions: parsePermissionScope(value.permissions),
  };

  if (value.maxFeesUSD !== undefined) {
    if (
      typeof value.maxFeesUSD !== "number" ||
      !Number.isFinite(value.maxFeesUSD)
    ) {
      throw new CliError("permissions maxFeesUSD must be a finite number");
    }
    request.maxFeesUSD = value.maxFeesUSD;
  }

  return request;
}

export function parseAllowCall(value: string): CallPermission {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliError("allow-call must use 0xTarget:signature");
  }

  const to = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  assertAddress(to, "allow-call target must be a 20-byte hex address");
  if (signature.length === 0) {
    throw new CliError("allow-call signature is required");
  }

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

  if (value.calls !== undefined && !Array.isArray(value.calls)) {
    throw new CliError("permissions calls must be an array");
  }

  if (!Array.isArray(value.spend)) {
    throw new CliError("permissions spend must be an array");
  }

  const permissions: AuthorizedKey["permissions"] = {
    spend: value.spend.map(parseSpendPermission),
  };
  if (value.calls !== undefined) {
    permissions.calls = value.calls.map(parseCallPermission);
  }

  return permissions;
}

function parseCallPermission(value: unknown): CallPermission {
  if (!isObject(value)) {
    throw new CliError("call permission must be an object");
  }

  const call: CallPermission = {};

  if (value.to !== undefined) {
    assertAddress(
      value.to,
      "call permission target must be a 20-byte hex address",
    );
    call.to = value.to;
  }
  if (value.signature !== undefined) {
    if (typeof value.signature !== "string" || value.signature.length === 0) {
      throw new CliError("call permission signature is required");
    }
    if (
      !selectorPattern.test(value.signature) &&
      (!value.signature.includes("(") || !value.signature.endsWith(")"))
    ) {
      throw new CliError(
        "call permission signature must be a function signature or 4-byte selector",
      );
    }
    call.signature = value.signature;
  }

  return call;
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
    spend.token = value.token;
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

function normalizeDefaultUsdmSpendLimit(value: string | undefined): string {
  if (value === undefined) {
    return defaultUsdmSpendLimit;
  }

  const amount = value.trim();
  if (!decimalAmountPattern.test(amount)) {
    throw new CliError("--spend-limit must be a positive decimal USDM amount");
  }

  const [whole = "", fraction = ""] = amount.split(".", 2);
  if (fraction.length > usdmDecimals) {
    throw new CliError(
      "--spend-limit must use at most 18 decimal places for USDM",
    );
  }

  const scale = 10n ** BigInt(usdmDecimals);
  const fractionalUnits =
    fraction.length === 0 ? 0n : BigInt(fraction.padEnd(usdmDecimals, "0"));
  const units = BigInt(whole) * scale + fractionalUnits;
  if (units <= 0n) {
    throw new CliError("--spend-limit must be greater than zero");
  }

  return units.toString();
}

function normalizeDecimalString(value: unknown, message: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new CliError(message);
    }
    return value.toString();
  }

  const normalized = typeof value === "number" ? value.toString() : value;
  if (typeof normalized === "string" && /^\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }

  throw new CliError(message);
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
