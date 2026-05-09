import { readFile } from "node:fs/promises";

import { CliError } from "../errors.js";
import type { AuthorizedKey, HexString } from "../config/profile.js";

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
  now?: Date;
};

const defaultPermissionTtlSeconds = 7 * 24 * 60 * 60;
const defaultFeeTokenLimit = "0.01";
const defaultUsdmSpendLimit = "100000000000000000000";
const mainnetUsdmAddress = "0xfafddbb3fc7688494971a79cc65dca3ef82079e7";
const periods = new Set(["minute", "hour", "day", "week", "month", "year"]);
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export async function resolveLoginPermissions(
  options: ResolvePermissionsOptions = {},
): Promise<CliPermissionRequest> {
  const request =
    options.permissionsFile === undefined
      ? defaultLoginPermissions(options.now)
      : parsePermissionRequest(
          JSON.parse(await readFile(options.permissionsFile, "utf8")),
        );

  const allowCalls = options.allowCalls ?? [];
  if (allowCalls.length === 0) {
    return request;
  }

  return {
    ...request,
    permissions: {
      ...request.permissions,
      calls: [...request.permissions.calls, ...allowCalls.map(parseAllowCall)],
    },
  };
}

export function defaultLoginPermissions(
  now = new Date(),
): CliPermissionRequest {
  return {
    expiry: Math.floor(now.getTime() / 1000) + defaultPermissionTtlSeconds,
    feeToken: {
      limit: defaultFeeTokenLimit,
      symbol: "ETH",
    },
    permissions: {
      calls: [],
      spend: [
        {
          limit: defaultUsdmSpendLimit,
          period: "week",
          token: mainnetUsdmAddress,
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

export function parseAllowCall(
  value: string,
): AuthorizedKey["permissions"]["calls"][number] {
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

  if (!Array.isArray(value.calls)) {
    throw new CliError("permissions calls must be an array");
  }

  if (!Array.isArray(value.spend)) {
    throw new CliError("permissions spend must be an array");
  }

  return {
    calls: value.calls.map(parseCallPermission),
    spend: value.spend.map(parseSpendPermission),
  };
}

function parseCallPermission(
  value: unknown,
): AuthorizedKey["permissions"]["calls"][number] {
  if (!isObject(value)) {
    throw new CliError("call permission must be an object");
  }

  assertAddress(
    value.to,
    "call permission target must be a 20-byte hex address",
  );
  if (typeof value.signature !== "string" || value.signature.length === 0) {
    throw new CliError("call permission signature is required");
  }

  return {
    to: value.to,
    signature: value.signature,
  };
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
