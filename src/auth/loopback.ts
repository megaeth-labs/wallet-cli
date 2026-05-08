import { spawn } from "node:child_process";
import { createECDH, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { platform } from "node:os";

import { getChainConfig, isNetwork, type Network } from "../config/chains.js";
import {
  parseWalletProfile,
  writeWalletProfile,
  type AuthorizedKey,
  type HexString,
  type WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  encodePermissions,
  parsePermissionScope,
  type CliPermissionRequest,
} from "./permissions.js";

export type LoopbackRedirectUri = `http://127.0.0.1:${number}/callback`;

export type CliAuthUrlParams = {
  walletUrl: string;
  accessAddress: HexString;
  permissions: string;
  redirectUri: LoopbackRedirectUri;
  state: string;
  network: Network;
  clientName: "mega-cli";
};

export type LoopbackCallback =
  | {
      state: string;
      status: "approved";
      accountAddress: HexString;
      accessAddress: HexString;
      authorizedKey: AuthorizedKey;
      grantTxHash?: HexString;
    }
  | {
      state: string;
      status: "cancelled" | "error";
      error?: string;
    };

export type DelegatedKeyPair = {
  privateKey: HexString;
  publicKey: HexString;
  accessAddress: HexString;
};

export type BrowserOpener = (url: string) => Promise<void> | void;

export type LoopbackLoginOptions = {
  network: Network;
  permissionRequest: CliPermissionRequest;
  walletUrl?: string;
  relayUrl?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  state?: string;
  privateKey?: HexString;
  openBrowser?: BrowserOpener;
};

export type LoopbackLoginResult = {
  profile: WalletProfile;
  authUrl: string;
};

type CallbackServer = {
  redirectUri: LoopbackRedirectUri;
  waitForCallback: Promise<LoopbackCallback>;
  close: () => Promise<void>;
};

type CallbackServerOptions = {
  state: string;
  accessAddress: HexString;
  timeoutMs: number;
};

const callbackPath = "/callback";
const defaultTimeoutMs = 120_000;
const stateBytes = 32;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hexPattern = /^0x[0-9a-fA-F]+$/;
const privateKeyPattern = /^0x[0-9a-fA-F]{64}$/;
const mask64 = (1n << 64n) - 1n;
const keccakRateBytes = 136;
const keccakRoundConstants = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];
const keccakRhoOffsets = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
] as const;

export async function runLoopbackLogin(
  options: LoopbackLoginOptions,
): Promise<LoopbackLoginResult> {
  const chainConfig = getChainConfig(options.network);
  const walletUrl = options.walletUrl ?? chainConfig.walletUrl;
  const relayUrl = options.relayUrl ?? chainConfig.relayUrl;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  assertPositiveTimeout(timeoutMs);

  const keyPair =
    options.privateKey === undefined
      ? generateDelegatedKeyPair()
      : deriveDelegatedKeyPair(options.privateKey);
  const state = options.state ?? createState();
  const callbackServer = await startLoopbackCallbackServer({
    state,
    accessAddress: keyPair.accessAddress,
    timeoutMs,
  });

  const authUrl = buildCliAuthUrl({
    walletUrl,
    accessAddress: keyPair.accessAddress,
    permissions: encodePermissions(options.permissionRequest),
    redirectUri: callbackServer.redirectUri,
    state,
    network: options.network,
    clientName: "mega-cli",
  });

  const waitForCallback = callbackServer.waitForCallback;
  waitForCallback.catch(() => undefined);

  try {
    await (options.openBrowser ?? openSystemBrowser)(authUrl);
    const callback = await waitForCallback;

    if (callback.status !== "approved") {
      throw new CliError(
        callback.status === "cancelled"
          ? "wallet authorization was cancelled"
          : `wallet authorization failed${callback.error ? `: ${callback.error}` : ""}`,
      );
    }

    const now = (options.now ?? new Date()).toISOString();
    const profile = parseWalletProfile({
      version: 1,
      network: options.network,
      accountAddress: callback.accountAddress,
      accessAddress: keyPair.accessAddress,
      privateKey: keyPair.privateKey,
      authorizedKey: callback.authorizedKey,
      grantTxHash: callback.grantTxHash,
      walletUrl,
      relayUrl,
      createdAt: now,
      updatedAt: now,
    });

    await writeWalletProfile(profile, options.env);

    return {
      profile,
      authUrl,
    };
  } finally {
    await callbackServer.close();
  }
}

export function buildCliAuthUrl(params: CliAuthUrlParams): string {
  assertAddress(
    params.accessAddress,
    "accessAddress must be a 20-byte hex address",
  );
  assertLoopbackRedirectUri(params.redirectUri);
  if (!isNetwork(params.network)) {
    throw new CliError(`unsupported network: ${params.network}`);
  }
  if (params.state.length < 16) {
    throw new CliError("state must be at least 16 characters");
  }
  if (params.permissions.length === 0) {
    throw new CliError("permissions are required");
  }

  const url = new URL("/cli-auth/loopback", params.walletUrl);
  url.searchParams.set("accessAddress", params.accessAddress);
  url.searchParams.set("permissions", params.permissions);
  url.searchParams.set("redirectUri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("network", params.network);
  url.searchParams.set("clientName", params.clientName);

  return url.toString();
}

export async function startLoopbackCallbackServer(
  options: CallbackServerOptions,
): Promise<CallbackServer> {
  assertPositiveTimeout(options.timeoutMs);
  assertAddress(
    options.accessAddress,
    "expected access address must be a 20-byte hex address",
  );

  let settled = false;
  let settleCallback: (callback: LoopbackCallback) => void = () => {};
  let rejectCallback: (error: Error) => void = () => {};
  let timer: NodeJS.Timeout | undefined;

  const waitForCallback = new Promise<LoopbackCallback>((resolve, reject) => {
    settleCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    handleCallbackRequest(request, response, options, (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }

      if (result instanceof Error) {
        rejectCallback(result);
      } else {
        settleCallback(result);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  timer = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    rejectCallback(
      new CliError(`wallet login timed out after ${options.timeoutMs}ms`),
    );
  }, options.timeoutMs);

  const address = server.address();
  if (!isAddressInfo(address)) {
    throw new CliError("failed to start loopback callback server");
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    waitForCallback,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (timer) {
          clearTimeout(timer);
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export function parseLoopbackCallback(
  params: URLSearchParams,
  expected: { state: string; accessAddress: HexString },
): LoopbackCallback {
  const state = requireParam(params, "state");
  if (!constantTimeEqual(state, expected.state)) {
    throw new CliError("callback state mismatch");
  }

  const status = requireParam(params, "status");
  if (status === "cancelled" || status === "error") {
    const callback: LoopbackCallback = {
      state,
      status,
    };
    const error = params.get("error");
    if (error) {
      callback.error = error;
    }
    return callback;
  }

  if (status !== "approved") {
    throw new CliError("callback status is invalid");
  }

  const accountAddress = requireAddress(params, "accountAddress");
  const accessAddress = requireAddress(params, "accessAddress");
  if (accessAddress.toLowerCase() !== expected.accessAddress.toLowerCase()) {
    throw new CliError("callback access address mismatch");
  }

  const grantTxHash = params.get("grantTxHash") ?? undefined;
  if (grantTxHash !== undefined) {
    assertHex(grantTxHash, "callback grantTxHash must be hex");
  }

  const callback: LoopbackCallback = {
    state,
    status: "approved",
    accountAddress,
    accessAddress,
    authorizedKey: parseAuthorizedKey(params.get("authorizedKey")),
  };
  if (grantTxHash !== undefined) {
    callback.grantTxHash = grantTxHash as HexString;
  }

  return callback;
}

export function generateDelegatedKeyPair(): DelegatedKeyPair {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();

  return deriveDelegatedKeyPair(`0x${ecdh.getPrivateKey().toString("hex")}`);
}

export function deriveDelegatedKeyPair(
  privateKey: HexString,
): DelegatedKeyPair {
  assertPrivateKey(privateKey);

  const ecdh = createECDH("secp256k1");
  const normalizedPrivateKey = privateKey.toLowerCase() as HexString;
  ecdh.setPrivateKey(Buffer.from(normalizedPrivateKey.slice(2), "hex"));

  const uncompressedPublicKey = ecdh.getPublicKey(undefined, "uncompressed");
  const publicKeyBytes = uncompressedPublicKey.subarray(1);

  return {
    privateKey: normalizedPrivateKey,
    publicKey: `0x${publicKeyBytes.toString("hex")}`,
    accessAddress: publicKeyToAddress(publicKeyBytes),
  };
}

export function keccak256(input: Uint8Array): Buffer {
  const state = new Array<bigint>(25).fill(0n);
  let offset = 0;

  while (offset + keccakRateBytes <= input.length) {
    absorbKeccakBlock(state, input.subarray(offset, offset + keccakRateBytes));
    keccakF1600(state);
    offset += keccakRateBytes;
  }

  const finalBlock = Buffer.alloc(keccakRateBytes);
  finalBlock.set(input.subarray(offset));
  finalBlock[input.length - offset] = 0x01;
  finalBlock[keccakRateBytes - 1] = finalBlock[keccakRateBytes - 1]! | 0x80;
  absorbKeccakBlock(state, finalBlock);
  keccakF1600(state);

  const output = Buffer.alloc(32);
  for (let index = 0; index < output.length; index += 1) {
    const lane = state[Math.floor(index / 8)]!;
    output[index] = Number((lane >> BigInt((index % 8) * 8)) & 0xffn);
  }

  return output;
}

export async function openSystemBrowser(url: string): Promise<void> {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
}

function handleCallbackRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CallbackServerOptions,
  settle: (result: LoopbackCallback | Error) => void,
): void {
  if (request.method !== "GET") {
    sendText(response, 405, "Method not allowed.");
    return;
  }

  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    sendText(response, 403, "Only loopback callbacks are allowed.");
    settle(new CliError("callback did not originate from loopback"));
    return;
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== callbackPath) {
    sendText(response, 404, "Not found.");
    return;
  }

  try {
    const callback = parseLoopbackCallback(url.searchParams, {
      state: options.state,
      accessAddress: options.accessAddress,
    });
    if (callback.status === "approved") {
      sendText(
        response,
        200,
        "Mega CLI authorization approved. You can close this tab.",
      );
    } else if (callback.status === "cancelled") {
      sendText(
        response,
        200,
        "Mega CLI authorization cancelled. You can close this tab.",
      );
    } else {
      sendText(
        response,
        400,
        "Mega CLI authorization failed. You can close this tab.",
      );
    }
    settle(callback);
  } catch (error) {
    sendText(response, 400, "Invalid Mega CLI authorization callback.");
    settle(error instanceof Error ? error : new CliError("invalid callback"));
  }
}

function parseAuthorizedKey(value: string | null): AuthorizedKey {
  if (!value) {
    throw new CliError("approved callback missing authorizedKey");
  }

  const decoded = decodeJsonParam(value, "authorizedKey");
  if (!isObject(decoded)) {
    throw new CliError("authorizedKey must be an object");
  }

  if (decoded.type !== "secp256k1") {
    throw new CliError("authorizedKey.type must be secp256k1");
  }
  if (decoded.role !== "session") {
    throw new CliError("authorizedKey.role must be session");
  }
  assertHex(decoded.publicKey, "authorizedKey.publicKey must be hex");
  if (
    typeof decoded.expiry !== "number" ||
    !Number.isSafeInteger(decoded.expiry) ||
    decoded.expiry <= 0
  ) {
    throw new CliError("authorizedKey.expiry must be a positive integer");
  }

  const authorizedKey: AuthorizedKey = {
    type: "secp256k1",
    role: "session",
    publicKey: decoded.publicKey,
    expiry: decoded.expiry,
    permissions: parsePermissionScope(decoded.permissions),
  };

  if (decoded.feeToken !== undefined) {
    if (!isObject(decoded.feeToken)) {
      throw new CliError("authorizedKey.feeToken must be an object");
    }
    if (
      typeof decoded.feeToken.limit !== "string" ||
      decoded.feeToken.limit.length === 0
    ) {
      throw new CliError("authorizedKey.feeToken.limit is required");
    }
    authorizedKey.feeToken = {
      limit: decoded.feeToken.limit,
    };
    if (decoded.feeToken.symbol !== undefined) {
      if (
        typeof decoded.feeToken.symbol !== "string" ||
        decoded.feeToken.symbol.length === 0
      ) {
        throw new CliError("authorizedKey.feeToken.symbol must be a string");
      }
      authorizedKey.feeToken.symbol = decoded.feeToken.symbol;
    }
  }

  return authorizedKey;
}

function decodeJsonParam(value: string, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      throw new CliError(`${label} must be base64url JSON`);
    }
  }
}

function publicKeyToAddress(publicKeyBytes: Uint8Array): HexString {
  const hash = keccak256(publicKeyBytes);
  return `0x${hash.subarray(hash.length - 20).toString("hex")}`;
}

function absorbKeccakBlock(state: bigint[], block: Uint8Array): void {
  for (let laneIndex = 0; laneIndex < keccakRateBytes / 8; laneIndex += 1) {
    state[laneIndex] =
      (state[laneIndex]! ^ readUint64Le(block, laneIndex * 8)) & mask64;
  }
}

function keccakF1600(state: bigint[]): void {
  for (let round = 0; round < 24; round += 1) {
    const c = new Array<bigint>(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      c[x] =
        state[x]! ^
        state[x + 5]! ^
        state[x + 10]! ^
        state[x + 15]! ^
        state[x + 20]!;
    }

    const d = new Array<bigint>(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5]! ^ rotateLeft64(c[(x + 1) % 5]!, 1);
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        state[index] = (state[index]! ^ d[x]!) & mask64;
      }
    }

    const b = new Array<bigint>(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const destination = y + 5 * ((2 * x + 3 * y) % 5);
        b[destination] = rotateLeft64(
          state[x + 5 * y]!,
          keccakRhoOffsets[x]![y]!,
        );
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const index = x + 5 * y;
        state[index] =
          (b[index]! ^
            ((mask64 ^ b[((x + 1) % 5) + 5 * y]!) &
              b[((x + 2) % 5) + 5 * y]!)) &
          mask64;
      }
    }

    state[0] = (state[0]! ^ keccakRoundConstants[round]!) & mask64;
  }
}

function readUint64Le(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index]!) << BigInt(index * 8);
  }
  return value;
}

function rotateLeft64(value: bigint, shift: number): bigint {
  const normalized = shift % 64;
  if (normalized === 0) {
    return value & mask64;
  }

  return (
    ((value << BigInt(normalized)) | (value >> BigInt(64 - normalized))) &
    mask64
  );
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (platform() === "darwin") {
    return { command: "open", args: [url] };
  }

  if (platform() === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

function createState(): string {
  return randomBytes(stateBytes).toString("base64url");
}

function requireParam(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value.length === 0) {
    throw new CliError(`callback ${name} is required`);
  }

  return value;
}

function requireAddress(params: URLSearchParams, name: string): HexString {
  const value = requireParam(params, name);
  assertAddress(value, `callback ${name} must be a 20-byte hex address`);
  return value;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function assertPositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError("timeout-ms must be a positive integer");
  }
}

function assertLoopbackRedirectUri(
  value: string,
): asserts value is LoopbackRedirectUri {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== callbackPath
    ) {
      throw new Error("not loopback");
    }
  } catch {
    throw new CliError("redirectUri must be a 127.0.0.1 callback URL");
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

function assertHex(
  value: unknown,
  message: string,
): asserts value is HexString {
  if (typeof value !== "string" || !hexPattern.test(value)) {
    throw new CliError(message);
  }
}

function assertPrivateKey(value: unknown): asserts value is HexString {
  if (typeof value !== "string" || !privateKeyPattern.test(value)) {
    throw new CliError("privateKey must be a 32-byte hex string");
  }
}

function isLoopbackRemoteAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

function isAddressInfo(
  value: string | AddressInfo | null,
): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  response.end(`${body}\n`);
}
