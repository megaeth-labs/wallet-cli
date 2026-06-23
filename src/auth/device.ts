import { timingSafeEqual } from "node:crypto";

import type { Network } from "../config/chains.js";
import {
  type AuthorizedKey,
  type HexString,
  type WalletKeyRecord,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  deriveDelegatedKeyPair,
  generateDelegatedKeyPair,
  type LoopbackKeyAuthorizationResult,
  type LoopbackRevokeResult,
} from "./loopback.js";
import {
  type CliPermissionRequest,
  parsePermissionScope,
} from "./permissions.js";
import { createPkcePair, createState } from "./pkce.js";

export type DeviceStartRequest =
  | {
      operation: "login";
      clientName: "mega-cli";
      network: Network;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      state: string;
    }
  | {
      operation: "grant";
      clientName: "mega-cli";
      network: Network;
      accessAddress: HexString;
      permissions: CliPermissionRequest;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      state: string;
      existingAccountAddress?: HexString;
    }
  | {
      operation: "revoke";
      clientName: "mega-cli";
      network: Network;
      accountAddress: HexString;
      accessAddress: HexString;
      feeToken?: string;
      codeChallenge: string;
      codeChallengeMethod: "S256";
      state: string;
    };

export type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceLoginApproved = {
  status: "approved";
  operation: "login";
  state: string;
  accountAddress: HexString;
};

export type DeviceGrantApproved = {
  status: "approved";
  operation: "grant";
  state: string;
  accountAddress: HexString;
  accessAddress: HexString;
  authorizedKey: AuthorizedKey;
  grantTxHash?: HexString;
};

export type DeviceRevokeApproved = {
  status: "approved";
  operation: "revoke";
  state: string;
  accountAddress: HexString;
  accessAddress: HexString;
  revokeTxHash?: HexString;
};

export type DeviceTokenResponse =
  | { status: "authorization_pending"; interval?: number }
  | { status: "slow_down"; interval: number }
  | { status: "expired_token" }
  | { status: "access_denied"; error?: string }
  | DeviceLoginApproved
  | DeviceGrantApproved
  | DeviceRevokeApproved;

export type DeviceTokenRequest = {
  deviceCode: string;
  codeVerifier: string;
};

export type AuthorizationPrompt = {
  verificationUri: string;
  verificationUriComplete: string;
  userCode: string;
  expiresAt: string;
};

export type DeviceAuthClient = {
  start: (request: DeviceStartRequest) => Promise<DeviceStartResponse>;
  token: (request: DeviceTokenRequest) => Promise<DeviceTokenResponse>;
};

export type DeviceLoginAuthorizationOptions = {
  network: Network;
  walletUrl: string;
  walletApiUrl: string;
  relayUrl: string;
  timeoutMs?: number;
  now?: Date;
  state?: string;
  client?: DeviceAuthClient;
  sleep?: (ms: number) => Promise<void>;
  onPrompt?: (prompt: AuthorizationPrompt) => void;
};

export type DeviceLoginAuthorizationResult = {
  accountAddress: HexString;
  authUrl: string;
  relayUrl: string;
  walletUrl: string;
};

export type DeviceGrantAuthorizationOptions = {
  network: Network;
  walletUrl: string;
  walletApiUrl: string;
  relayUrl: string;
  permissionRequest: CliPermissionRequest;
  existingAccountAddress?: HexString;
  timeoutMs?: number;
  now?: Date;
  state?: string;
  privateKey?: HexString;
  client?: DeviceAuthClient;
  sleep?: (ms: number) => Promise<void>;
  onPrompt?: (prompt: AuthorizationPrompt) => void;
};

export type DeviceRevokeAuthorizationOptions = {
  network: Network;
  walletApiUrl: string;
  accountAddress: HexString;
  accessAddress: HexString;
  feeToken?: string;
  timeoutMs?: number;
  state?: string;
  client?: DeviceAuthClient;
  sleep?: (ms: number) => Promise<void>;
  onPrompt?: (prompt: AuthorizationPrompt) => void;
};

const defaultTimeoutMs = 120_000;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hexPattern = /^0x[0-9a-fA-F]+$/;
const minimumPollIntervalSeconds = 1;

export class HttpDeviceAuthClient implements DeviceAuthClient {
  readonly #walletApiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(walletApiUrl: string, fetchImpl: typeof fetch = fetch) {
    this.#walletApiUrl = walletApiUrl;
    this.#fetch = fetchImpl;
  }

  async start(request: DeviceStartRequest): Promise<DeviceStartResponse> {
    const response = await this.#postJson("/v1/cli-auth/device/start", request);
    return parseDeviceStartResponse(response);
  }

  async token(request: DeviceTokenRequest): Promise<DeviceTokenResponse> {
    const response = await this.#postJson("/v1/cli-auth/device/token", request);
    return parseDeviceTokenResponse(response);
  }

  async #postJson(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, this.#walletApiUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new CliError(
        `wallet device authorization service is unavailable at ${this.#walletApiUrl}: ${formatUnknownError(error)}`,
      );
    }

    const payload = await parseJsonResponse(response, path);
    if (!response.ok) {
      if (path.endsWith("/start") && isUnavailableStatus(response.status)) {
        throw new CliError(
          `device-code auth is not available from wallet API ${this.#walletApiUrl}; use loopback auth or update the wallet backend`,
        );
      }
      const detail = extractErrorMessage(payload);
      if (path.endsWith("/token") && isPkceError(detail)) {
        throw new CliError(
          "device authorization security check failed; rerun the command",
        );
      }
      throw new CliError(
        detail === undefined
          ? `wallet device authorization request failed (${response.status})`
          : `wallet device authorization request failed (${response.status}): ${detail}`,
      );
    }
    return payload;
  }
}

export async function authorizeDeviceLogin(
  options: DeviceLoginAuthorizationOptions,
): Promise<DeviceLoginAuthorizationResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  assertPositiveTimeout(timeoutMs);
  assertUrl(options.walletUrl, "walletUrl must be a valid URL");
  assertUrl(options.walletApiUrl, "walletApiUrl must be a valid URL");
  assertUrl(options.relayUrl, "relayUrl must be a valid URL");

  const state = options.state ?? createState();
  assertState(state);
  const pkce = createPkcePair();
  const client =
    options.client ?? new HttpDeviceAuthClient(options.walletApiUrl);

  const start = await client.start({
    operation: "login",
    clientName: "mega-cli",
    network: options.network,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
  });
  options.onPrompt?.(buildAuthorizationPrompt(start, options.now));

  const approved = await pollDeviceApproval(client, {
    deviceCode: start.deviceCode,
    codeVerifier: pkce.codeVerifier,
    intervalSeconds: start.interval,
    timeoutMs: Math.min(timeoutMs, start.expiresIn * 1000),
    sleep: options.sleep,
  });

  if (approved.operation !== "login") {
    throw new CliError("device authorization operation mismatch");
  }
  validateDeviceState(approved, state);

  return {
    accountAddress: approved.accountAddress,
    authUrl: start.verificationUriComplete,
    relayUrl: options.relayUrl,
    walletUrl: options.walletUrl,
  };
}

export async function authorizeDeviceKey(
  options: DeviceGrantAuthorizationOptions,
): Promise<LoopbackKeyAuthorizationResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  assertPositiveTimeout(timeoutMs);
  assertUrl(options.walletApiUrl, "walletApiUrl must be a valid URL");

  const keyPair =
    options.privateKey === undefined
      ? generateDelegatedKeyPair()
      : deriveDelegatedKeyPair(options.privateKey);
  const state = options.state ?? createState();
  assertState(state);
  const pkce = createPkcePair();
  const client =
    options.client ?? new HttpDeviceAuthClient(options.walletApiUrl);

  const start = await client.start({
    operation: "grant",
    clientName: "mega-cli",
    network: options.network,
    accessAddress: keyPair.accessAddress,
    permissions: options.permissionRequest,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
    ...(options.existingAccountAddress === undefined
      ? {}
      : { existingAccountAddress: options.existingAccountAddress }),
  });
  options.onPrompt?.(buildAuthorizationPrompt(start, options.now));

  const approved = await pollDeviceApproval(client, {
    deviceCode: start.deviceCode,
    codeVerifier: pkce.codeVerifier,
    intervalSeconds: start.interval,
    timeoutMs: Math.min(timeoutMs, start.expiresIn * 1000),
    sleep: options.sleep,
  });

  if (approved.operation !== "grant") {
    throw new CliError("device authorization operation mismatch");
  }
  validateApprovalCommon(approved, {
    state,
    accessAddress: keyPair.accessAddress,
  });
  if (
    options.existingAccountAddress !== undefined &&
    approved.accountAddress.toLowerCase() !==
      options.existingAccountAddress.toLowerCase()
  ) {
    throw new CliError("device authorization account address mismatch");
  }

  const now = (options.now ?? new Date()).toISOString();
  const key: WalletKeyRecord = {
    id: keyPair.accessAddress,
    accessAddress: keyPair.accessAddress,
    privateKey: keyPair.privateKey,
    authorizedKey: approved.authorizedKey,
    grantTxHash: approved.grantTxHash,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };

  return {
    accountAddress: approved.accountAddress,
    authUrl: start.verificationUriComplete,
    key,
    relayUrl: options.relayUrl,
    walletUrl: options.walletUrl,
  };
}

export async function authorizeDeviceRevoke(
  options: DeviceRevokeAuthorizationOptions,
): Promise<LoopbackRevokeResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  assertPositiveTimeout(timeoutMs);
  assertUrl(options.walletApiUrl, "walletApiUrl must be a valid URL");
  assertAddress(
    options.accountAddress,
    "accountAddress must be a 20-byte hex address",
  );
  assertAddress(
    options.accessAddress,
    "accessAddress must be a 20-byte hex address",
  );

  const state = options.state ?? createState();
  assertState(state);
  const pkce = createPkcePair();
  const client =
    options.client ?? new HttpDeviceAuthClient(options.walletApiUrl);

  const start = await client.start({
    operation: "revoke",
    clientName: "mega-cli",
    network: options.network,
    accountAddress: options.accountAddress,
    accessAddress: options.accessAddress,
    ...(options.feeToken === undefined ? {} : { feeToken: options.feeToken }),
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    state,
  });
  options.onPrompt?.(buildAuthorizationPrompt(start));

  const approved = await pollDeviceApproval(client, {
    deviceCode: start.deviceCode,
    codeVerifier: pkce.codeVerifier,
    intervalSeconds: start.interval,
    timeoutMs: Math.min(timeoutMs, start.expiresIn * 1000),
    sleep: options.sleep,
  });

  if (approved.operation !== "revoke") {
    throw new CliError("device authorization operation mismatch");
  }
  validateApprovalCommon(approved, {
    state,
    accessAddress: options.accessAddress,
  });
  if (
    approved.accountAddress.toLowerCase() !==
    options.accountAddress.toLowerCase()
  ) {
    throw new CliError("device authorization account address mismatch");
  }

  return {
    authUrl: start.verificationUriComplete,
    revokeTxHash: approved.revokeTxHash,
  };
}

export async function pollDeviceApproval(
  client: DeviceAuthClient,
  options: {
    deviceCode: string;
    codeVerifier: string;
    intervalSeconds: number;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DeviceLoginApproved | DeviceGrantApproved | DeviceRevokeApproved> {
  assertPositiveTimeout(options.timeoutMs);
  let intervalMs = intervalToMs(options.intervalSeconds);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new CliError("wallet device authorization timed out");
    }

    await sleep(Math.min(intervalMs, remainingMs));
    const response = await client.token({
      deviceCode: options.deviceCode,
      codeVerifier: options.codeVerifier,
    });

    switch (response.status) {
      case "approved":
        return response;
      case "authorization_pending":
        if (response.interval !== undefined) {
          intervalMs = intervalToMs(response.interval);
        }
        break;
      case "slow_down":
        intervalMs = intervalToMs(response.interval);
        break;
      case "expired_token":
        throw new CliError(
          "wallet device authorization expired; rerun the command",
        );
      case "access_denied":
        throw new CliError(
          response.error === undefined
            ? "wallet device authorization was rejected"
            : `wallet device authorization was rejected: ${response.error}`,
        );
      default:
        assertNever(response);
    }
  }
}

export function parseDeviceStartResponse(value: unknown): DeviceStartResponse {
  if (!isObject(value)) {
    throw new CliError("device start response must be an object");
  }
  return {
    deviceCode: requireString(value.deviceCode, "deviceCode"),
    userCode: requireString(value.userCode, "userCode"),
    verificationUri: requireString(value.verificationUri, "verificationUri"),
    verificationUriComplete: requireString(
      value.verificationUriComplete,
      "verificationUriComplete",
    ),
    expiresIn: requirePositiveInteger(value.expiresIn, "expiresIn"),
    interval: requirePositiveInteger(value.interval, "interval"),
  };
}

export function parseDeviceTokenResponse(value: unknown): DeviceTokenResponse {
  if (!isObject(value)) {
    throw new CliError("device token response must be an object");
  }
  const status = requireString(value.status, "status");
  switch (status) {
    case "authorization_pending": {
      const pending: DeviceTokenResponse = { status };
      if (value.interval !== undefined) {
        pending.interval = requirePositiveInteger(value.interval, "interval");
      }
      return pending;
    }
    case "slow_down":
      return {
        status,
        interval: requirePositiveInteger(value.interval, "interval"),
      };
    case "expired_token":
      return { status };
    case "access_denied": {
      const denied: DeviceTokenResponse = { status };
      if (value.error !== undefined) {
        denied.error = requireString(value.error, "error");
      }
      return denied;
    }
    case "approved":
      return parseApprovedDeviceResponse(value);
    default:
      throw new CliError("device token status is invalid");
  }
}

export function buildAuthorizationPrompt(
  start: DeviceStartResponse,
  now = new Date(),
): AuthorizationPrompt {
  return {
    verificationUri: start.verificationUri,
    verificationUriComplete: start.verificationUriComplete,
    userCode: start.userCode,
    expiresAt: new Date(now.getTime() + start.expiresIn * 1000).toISOString(),
  };
}

function parseApprovedDeviceResponse(
  value: Record<string, unknown>,
): DeviceLoginApproved | DeviceGrantApproved | DeviceRevokeApproved {
  const operation = requireString(value.operation, "operation");
  const base = {
    status: "approved" as const,
    state: requireString(value.state, "state"),
    accountAddress: requireAddress(value.accountAddress, "accountAddress"),
  };
  if (operation === "login") {
    return {
      ...base,
      operation,
    };
  }
  if (operation === "grant") {
    const approved: DeviceGrantApproved = {
      ...base,
      operation,
      accessAddress: requireAddress(value.accessAddress, "accessAddress"),
      authorizedKey: parseAuthorizedKey(value.authorizedKey),
    };
    if (value.grantTxHash !== undefined) {
      approved.grantTxHash = requireHex(value.grantTxHash, "grantTxHash");
    }
    return approved;
  }
  if (operation === "revoke") {
    const approved: DeviceRevokeApproved = {
      ...base,
      operation,
      accessAddress: requireAddress(value.accessAddress, "accessAddress"),
    };
    if (value.revokeTxHash !== undefined) {
      approved.revokeTxHash = requireHex(value.revokeTxHash, "revokeTxHash");
    }
    return approved;
  }
  throw new CliError("device token operation is invalid");
}

function parseAuthorizedKey(value: unknown): AuthorizedKey {
  if (!isObject(value)) {
    throw new CliError("authorizedKey must be an object");
  }
  if (value.type !== "secp256k1") {
    throw new CliError("authorizedKey.type must be secp256k1");
  }
  if (value.role !== "session") {
    throw new CliError("authorizedKey.role must be session");
  }
  const authorizedKey: AuthorizedKey = {
    type: "secp256k1",
    role: "session",
    publicKey: requireHex(value.publicKey, "authorizedKey.publicKey"),
    expiry: requirePositiveInteger(value.expiry, "authorizedKey.expiry"),
    permissions: parsePermissionScope(value.permissions),
  };
  if (value.feeToken !== undefined) {
    if (!isObject(value.feeToken)) {
      throw new CliError("authorizedKey.feeToken must be an object");
    }
    authorizedKey.feeToken = {
      limit: requireString(
        value.feeToken.limit,
        "authorizedKey.feeToken.limit",
      ),
    };
    if (value.feeToken.symbol !== undefined) {
      authorizedKey.feeToken.symbol = requireString(
        value.feeToken.symbol,
        "authorizedKey.feeToken.symbol",
      );
    }
  }
  return authorizedKey;
}

function validateApprovalCommon(
  approved: DeviceGrantApproved | DeviceRevokeApproved,
  expected: { state: string; accessAddress: HexString },
): void {
  validateDeviceState(approved, expected.state);
  if (
    approved.accessAddress.toLowerCase() !==
    expected.accessAddress.toLowerCase()
  ) {
    throw new CliError("device authorization access address mismatch");
  }
}

function validateDeviceState(
  approved: DeviceLoginApproved | DeviceGrantApproved | DeviceRevokeApproved,
  expectedState: string,
): void {
  if (!constantTimeEqual(approved.state, expectedState)) {
    throw new CliError("device authorization state mismatch");
  }
}

function assertState(value: string): void {
  if (value.length < 16) {
    throw new CliError("state must be at least 16 characters");
  }
}

function assertPositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError("timeout-ms must be a positive integer");
  }
}

function assertUrl(value: string, message: string): void {
  try {
    new URL(value);
  } catch {
    throw new CliError(message);
  }
}

function assertAddress(
  value: unknown,
  message: string,
): asserts value is HexString {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    throw new CliError(message);
  }
}

function requireAddress(value: unknown, name: string): HexString {
  assertAddress(value, `${name} must be a 20-byte hex address`);
  return value;
}

function requireHex(value: unknown, name: string): HexString {
  if (typeof value !== "string" || !hexPattern.test(value)) {
    throw new CliError(`${name} must be hex`);
  }
  return value as HexString;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(`${name} must be a positive integer`);
  }
  return value;
}

function intervalToMs(seconds: number): number {
  return (
    Math.max(
      requirePositiveInteger(seconds, "interval"),
      minimumPollIntervalSeconds,
    ) * 1000
  );
}

async function parseJsonResponse(
  response: Response,
  path: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (path.endsWith("/start") && isUnavailableStatus(response.status)) {
      throw new CliError(
        `device-code auth is not available from this wallet API; use loopback auth or update the wallet backend`,
      );
    }

    throw new CliError("wallet device authorization response was not JSON");
  }
}

function isUnavailableStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function isPkceError(message: string | undefined): boolean {
  return message !== undefined && /PKCE|code verifier/i.test(message);
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  if (typeof value.error === "string" && value.error.length > 0) {
    return value.error;
  }

  if (typeof value.status === "string" && value.status.length > 0) {
    return value.status;
  }

  if (typeof value.message === "string" && value.message.length > 0) {
    return value.message;
  }

  return undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new CliError(
    `unexpected device authorization status: ${String(value)}`,
  );
}
