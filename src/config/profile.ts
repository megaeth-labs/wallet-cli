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
import { defaultNetwork, isNetwork, type Network } from "./chains.js";
import { getProfilePath } from "./paths.js";

export type HexString = `0x${string}`;

export type PermissionPeriod =
  | "minute"
  | "hour"
  | "day"
  | "week"
  | "month"
  | "year";

export type CallPermission = {
  to?: HexString;
  signature?: string;
};

export type SpendPermission = {
  limit: string;
  period: PermissionPeriod;
  token?: HexString;
};

export type PermissionScope = {
  calls?: CallPermission[];
  spend: SpendPermission[];
};

export type AuthorizedKey = {
  type: "secp256k1";
  role: "session";
  publicKey: HexString;
  expiry: number;
  feeToken?: {
    limit: string;
    symbol?: string;
  };
  permissions: PermissionScope;
};

export type WalletKeyStatus = "active" | "revoked";

export type WalletKeyRecord = {
  id: HexString;
  accessAddress: HexString;
  privateKey?: HexString;
  authorizedKey: AuthorizedKey;
  label?: string;
  status: WalletKeyStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  grantTxHash?: HexString;
  revokeTxHash?: HexString;
  revokedAt?: string;
};

export type WalletProfile = {
  version: 1;
  network: Network;
  accountAddress: HexString;
  activeKeyId?: HexString;
  keys: WalletKeyRecord[];
  walletUrl: string;
  relayUrl: string;
  createdAt: string;
  updatedAt: string;
};

export type WalletKeySummary = Omit<WalletKeyRecord, "privateKey">;

export type ProfileSummary = Omit<WalletProfile, "keys"> & {
  keys: WalletKeySummary[];
};

export function serializePermissions(
  permissions: AuthorizedKey["permissions"],
): string {
  return JSON.stringify(permissions);
}

export function summarizeProfile(profile: WalletProfile): ProfileSummary {
  const summary = {
    ...profile,
    keys: profile.keys.map(({ privateKey: _privateKey, ...key }) => key),
  };

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
      const loginInstruction =
        network === defaultNetwork
          ? "mega wallet login"
          : `mega wallet login --network ${network}`;
      throw new CliError(
        `no ${network} wallet profile found; run ${loginInstruction}`,
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

export function findWalletKey(
  profile: WalletProfile,
  selector: string | undefined,
): WalletKeyRecord | undefined {
  if (selector === undefined) {
    return getActiveWalletKey(profile);
  }

  const normalized = selector.toLowerCase();

  return profile.keys.find(
    (key) =>
      key.id.toLowerCase() === normalized ||
      key.accessAddress.toLowerCase() === normalized ||
      key.authorizedKey.publicKey.toLowerCase() === normalized,
  );
}

export function getActiveWalletKey(
  profile: WalletProfile,
): WalletKeyRecord | undefined {
  if (profile.activeKeyId !== undefined) {
    const active = findWalletKey(profile, profile.activeKeyId);
    if (active !== undefined) {
      return active;
    }
  }

  return profile.keys.find((key) => key.status === "active");
}

export function isWalletKeyExpired(
  key: WalletKeyRecord,
  now = new Date(),
): boolean {
  return key.authorizedKey.expiry * 1000 <= now.getTime();
}

export function isWalletKeyUsable(
  key: WalletKeyRecord,
  now = new Date(),
): boolean {
  return (
    key.status === "active" &&
    !isWalletKeyExpired(key, now) &&
    key.privateKey !== undefined
  );
}

export function requireUsableWalletKey(
  profile: WalletProfile,
  selector: string | undefined,
  now = new Date(),
): WalletKeyRecord {
  const key = findWalletKey(profile, selector);
  if (key === undefined) {
    throw new CliError(
      selector === undefined
        ? noDefaultWalletKeyMessage(profile)
        : `delegated key not found: ${selector}`,
    );
  }

  if (!isWalletKeyUsable(key, now)) {
    const status =
      key.status === "revoked"
        ? "revoked"
        : isWalletKeyExpired(key, now)
          ? "expired"
          : "missing private key material";
    throw new CliError(
      `delegated key ${key.accessAddress} is ${status}; run mega wallet create-key or switch to another usable key`,
    );
  }

  return key;
}

function noDefaultWalletKeyMessage(profile: WalletProfile): string {
  if (profile.keys.length === 0) {
    return "wallet profile has no delegated keys; run mega wallet create-key";
  }

  return "wallet profile has no usable default delegated key; run mega wallet list --show-inactive, then mega wallet switch <key> or mega wallet create-key";
}

export function markWalletKeyUsed(
  profile: WalletProfile,
  keyId: HexString,
  now = new Date(),
): WalletProfile {
  const timestamp = now.toISOString();

  return parseWalletProfile({
    ...profile,
    keys: profile.keys.map((key) =>
      sameHex(key.id, keyId)
        ? { ...key, lastUsedAt: timestamp, updatedAt: timestamp }
        : key,
    ),
    updatedAt: timestamp,
  });
}

export function setActiveWalletKey(
  profile: WalletProfile,
  keyId: HexString,
  now = new Date(),
): WalletProfile {
  const key = findWalletKey(profile, keyId);
  if (key === undefined) {
    throw new CliError(`delegated key not found: ${keyId}`);
  }
  if (!isWalletKeyUsable(key, now)) {
    throw new CliError(`delegated key is not usable: ${keyId}`);
  }

  const timestamp = now.toISOString();
  return parseWalletProfile({
    ...profile,
    activeKeyId: key.id,
    keys: profile.keys.map((entry) =>
      sameHex(entry.id, key.id)
        ? { ...entry, lastUsedAt: timestamp, updatedAt: timestamp }
        : entry,
    ),
    updatedAt: timestamp,
  });
}

export function addWalletKey(
  profile: WalletProfile,
  key: WalletKeyRecord,
  now = new Date(),
): WalletProfile {
  if (findWalletKey(profile, key.id) !== undefined) {
    throw new CliError(`delegated key already exists: ${key.id}`);
  }

  const timestamp = now.toISOString();
  return parseWalletProfile({
    ...profile,
    activeKeyId: key.id,
    keys: [
      ...profile.keys,
      {
        ...key,
        lastUsedAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    updatedAt: timestamp,
  });
}

export function revokeWalletKeyLocal(
  profile: WalletProfile,
  keyId: HexString,
  options: { revokeTxHash?: HexString; now?: Date } = {},
): WalletProfile {
  const key = findWalletKey(profile, keyId);
  if (key === undefined) {
    throw new CliError(`delegated key not found: ${keyId}`);
  }

  const timestamp = (options.now ?? new Date()).toISOString();
  const revokedKey: WalletKeyRecord = {
    ...key,
    status: "revoked",
    updatedAt: timestamp,
    revokedAt: timestamp,
    ...(options.revokeTxHash === undefined
      ? {}
      : { revokeTxHash: options.revokeTxHash }),
  };
  const { privateKey: _privateKey, ...auditOnlyKey } = revokedKey;
  const activeKeyId = sameHex(profile.activeKeyId, key.id)
    ? undefined
    : profile.activeKeyId;

  return parseWalletProfile({
    ...profile,
    activeKeyId,
    keys: profile.keys.map((entry) =>
      sameHex(entry.id, key.id) ? auditOnlyKey : entry,
    ),
    updatedAt: timestamp,
  });
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
  if (
    "accessAddress" in profile ||
    "privateKey" in profile ||
    "authorizedKey" in profile
  ) {
    throw new CliError(
      "wallet profile format changed; run mega wallet login again",
    );
  }
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
  assertOptionalHex(
    profile.activeKeyId,
    "wallet profile activeKeyId must be a hex string",
  );
  if (!Array.isArray(profile.keys)) {
    throw new CliError("wallet profile keys must be an array");
  }
  for (const key of profile.keys) {
    assertWalletKeyRecord(key);
  }
  if (
    profile.activeKeyId !== undefined &&
    !profile.keys.some(
      (key) =>
        isObject(key) &&
        typeof key.id === "string" &&
        sameHex(key.id as HexString, profile.activeKeyId as HexString),
    )
  ) {
    throw new CliError("wallet profile activeKeyId must reference a key");
  }
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

function assertWalletKeyRecord(
  value: unknown,
): asserts value is WalletKeyRecord {
  if (!isObject(value)) {
    throw new CliError("wallet profile key must be an object");
  }

  assertHex(value.id, "wallet profile key id is required");
  assertHex(
    value.accessAddress,
    "wallet profile key accessAddress is required",
  );
  if (value.privateKey !== undefined) {
    assertPrivateKey(value.privateKey);
  }
  assertAuthorizedKey(value.authorizedKey);
  if (value.label !== undefined) {
    assertString(value.label, "wallet profile key label must be a string");
  }
  if (value.status !== "active" && value.status !== "revoked") {
    throw new CliError("wallet profile key status must be active or revoked");
  }
  assertIsoDate(
    value.createdAt,
    "wallet profile key createdAt must be an ISO timestamp",
  );
  assertIsoDate(
    value.updatedAt,
    "wallet profile key updatedAt must be an ISO timestamp",
  );
  if (value.lastUsedAt !== undefined) {
    assertIsoDate(
      value.lastUsedAt,
      "wallet profile key lastUsedAt must be an ISO timestamp",
    );
  }
  assertOptionalHex(
    value.grantTxHash,
    "wallet profile key grantTxHash must be a hex string",
  );
  assertOptionalHex(
    value.revokeTxHash,
    "wallet profile key revokeTxHash must be a hex string",
  );
  if (value.revokedAt !== undefined) {
    assertIsoDate(
      value.revokedAt,
      "wallet profile key revokedAt must be an ISO timestamp",
    );
  }
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

  if (
    value.permissions.calls !== undefined &&
    !Array.isArray(value.permissions.calls)
  ) {
    throw new CliError(
      "wallet profile authorizedKey.permissions.calls must be an array",
    );
  }
  for (const call of value.permissions.calls ?? []) {
    if (!isObject(call)) {
      throw new CliError("wallet profile call permission must be an object");
    }
    if (call.to !== undefined) {
      assertAddress(
        call.to,
        "wallet profile call permission target must be a 20-byte hex address",
      );
    }
    if (call.signature !== undefined) {
      assertString(
        call.signature,
        "wallet profile call permission signature must be a string",
      );
    }
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

function assertAddress(
  value: unknown,
  message: string,
): asserts value is HexString {
  assertString(value, message);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new CliError(message);
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

function sameHex(left: unknown, right: unknown): boolean {
  return (
    typeof left === "string" &&
    typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
