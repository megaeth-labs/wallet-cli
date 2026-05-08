import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";

import { CliError } from "../errors.js";
import { redactSecrets } from "../output.js";
import { isNetwork, type Network } from "./chains.js";
import { getProfilePath } from "./paths.js";

export type HexString = `0x${string}`;

export type PermissionPeriod =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export type AuthorizedKey = {
  type: "secp256k1";
  role: "session";
  publicKey: HexString;
  expiry: number;
  feeToken?: {
    limit: string;
    symbol?: string;
  };
  permissions: {
    calls: {
      to: HexString;
      signature: string;
    }[];
    spend: {
      limit: string;
      period: PermissionPeriod;
      token?: HexString;
    }[];
  };
};

export type WalletProfile = {
  version: 1;
  network: Network;
  accountAddress: HexString;
  accessAddress: HexString;
  privateKey: HexString;
  authorizedKey: AuthorizedKey;
  grantTxHash?: HexString;
  walletUrl: string;
  relayUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type ProfileSummary = Omit<WalletProfile, "privateKey">;

export function serializePermissions(
  permissions: AuthorizedKey["permissions"],
): string {
  return JSON.stringify(permissions);
}

export function summarizeProfile(profile: WalletProfile): ProfileSummary {
  const { privateKey: _privateKey, ...summary } = profile;

  return redactSecrets(summary);
}

export async function profileExists(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await access(getProfilePath(network, env), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readWalletProfile(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalletProfile> {
  const path = getProfilePath(network, env);

  try {
    const raw = await readFile(path, "utf8");
    return parseWalletProfile(JSON.parse(raw));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new CliError(
        `no ${network} wallet profile found; run mega wallet login --network ${network}`,
      );
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`wallet profile for ${network} is not valid JSON`);
    }

    throw error;
  }
}

export async function writeWalletProfile(
  profile: WalletProfile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const validated = parseWalletProfile(profile);
  const path = getProfilePath(validated.network, env);
  const dir = dirname(path);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(validated, null, 2)}\n`;

  await mkdir(dir, { recursive: true, mode: 0o700 });

  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(data, "utf8");
  } finally {
    await file.close();
  }

  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

export async function deleteWalletProfile(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    await rm(getProfilePath(network, env));
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

export async function listWalletProfiles(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WalletProfile[]> {
  const profiles: WalletProfile[] = [];

  for (const network of ["mainnet", "testnet"] as const) {
    const path = getProfilePath(network, env);
    try {
      const raw = await readFile(path, "utf8");
      profiles.push(parseWalletProfile(JSON.parse(raw)));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
  }

  return profiles;
}

export async function getProfileMode(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const info = await stat(getProfilePath(network, env));
  return info.mode & 0o777;
}

export function parseWalletProfile(value: unknown): WalletProfile {
  if (!isObject(value)) {
    throw new CliError("wallet profile must be an object");
  }

  const profile = value as Record<string, unknown>;
  assertEqual(profile.version, 1, "wallet profile version must be 1");
  assertString(profile.network, "wallet profile network is required");
  if (!isNetwork(profile.network)) {
    throw new CliError(
      `unsupported wallet profile network: ${profile.network}`,
    );
  }

  assertHex(
    profile.accountAddress,
    "wallet profile accountAddress is required",
  );
  assertHex(profile.accessAddress, "wallet profile accessAddress is required");
  assertPrivateKey(profile.privateKey);
  assertAuthorizedKey(profile.authorizedKey);
  assertOptionalHex(
    profile.grantTxHash,
    "wallet profile grantTxHash must be a hex string",
  );
  assertUrl(profile.walletUrl, "wallet profile walletUrl must be a URL");
  assertUrl(profile.relayUrl, "wallet profile relayUrl must be a URL");
  assertIsoDate(
    profile.createdAt,
    "wallet profile createdAt must be an ISO timestamp",
  );
  assertIsoDate(
    profile.updatedAt,
    "wallet profile updatedAt must be an ISO timestamp",
  );

  return profile as WalletProfile;
}

function assertAuthorizedKey(value: unknown): asserts value is AuthorizedKey {
  if (!isObject(value)) {
    throw new CliError("wallet profile authorizedKey must be an object");
  }

  assertEqual(
    value.type,
    "secp256k1",
    "wallet profile authorizedKey.type must be secp256k1",
  );
  assertEqual(
    value.role,
    "session",
    "wallet profile authorizedKey.role must be session",
  );
  assertHex(
    value.publicKey,
    "wallet profile authorizedKey.publicKey is required",
  );
  if (
    typeof value.expiry !== "number" ||
    !Number.isSafeInteger(value.expiry) ||
    value.expiry <= 0
  ) {
    throw new CliError(
      "wallet profile authorizedKey.expiry must be a positive integer",
    );
  }

  if (value.feeToken !== undefined) {
    if (!isObject(value.feeToken)) {
      throw new CliError(
        "wallet profile authorizedKey.feeToken must be an object",
      );
    }
    assertString(
      value.feeToken.limit,
      "wallet profile authorizedKey.feeToken.limit is required",
    );
    if (value.feeToken.symbol !== undefined) {
      assertString(
        value.feeToken.symbol,
        "wallet profile authorizedKey.feeToken.symbol must be a string",
      );
    }
  }

  if (!isObject(value.permissions)) {
    throw new CliError(
      "wallet profile authorizedKey.permissions must be an object",
    );
  }

  if (!Array.isArray(value.permissions.calls)) {
    throw new CliError(
      "wallet profile authorizedKey.permissions.calls must be an array",
    );
  }
  for (const call of value.permissions.calls) {
    if (!isObject(call)) {
      throw new CliError("wallet profile call permission must be an object");
    }
    assertHex(call.to, "wallet profile call permission target is required");
    assertString(
      call.signature,
      "wallet profile call permission signature is required",
    );
  }

  if (!Array.isArray(value.permissions.spend)) {
    throw new CliError(
      "wallet profile authorizedKey.permissions.spend must be an array",
    );
  }
  for (const spend of value.permissions.spend) {
    if (!isObject(spend)) {
      throw new CliError("wallet profile spend permission must be an object");
    }
    assertString(
      spend.limit,
      "wallet profile spend permission limit is required",
    );
    assertString(
      spend.period,
      "wallet profile spend permission period is required",
    );
    if (
      !["minute", "hour", "day", "week", "month", "year"].includes(spend.period)
    ) {
      throw new CliError(
        `unsupported spend permission period: ${spend.period}`,
      );
    }
    assertOptionalHex(
      spend.token,
      "wallet profile spend permission token must be a hex string",
    );
  }
}

function assertEqual(value: unknown, expected: unknown, message: string): void {
  if (value !== expected) {
    throw new CliError(message);
  }
}

function assertString(
  value: unknown,
  message: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(message);
  }
}

function assertHex(
  value: unknown,
  message: string,
): asserts value is HexString {
  assertString(value, message);
  if (!/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new CliError(message);
  }
}

function assertOptionalHex(
  value: unknown,
  message: string,
): asserts value is HexString | undefined {
  if (value !== undefined) {
    assertHex(value, message);
  }
}

function assertPrivateKey(value: unknown): asserts value is HexString {
  assertHex(value, "wallet profile privateKey is required");
  if (value.length !== 66) {
    throw new CliError(
      "wallet profile privateKey must be a 32-byte hex string",
    );
  }
}

function assertUrl(value: unknown, message: string): asserts value is string {
  assertString(value, message);
  try {
    new URL(value);
  } catch {
    throw new CliError(message);
  }
}

function assertIsoDate(
  value: unknown,
  message: string,
): asserts value is string {
  assertString(value, message);
  if (Number.isNaN(Date.parse(value))) {
    throw new CliError(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
