import { getChainConfig, type Network } from "../config/chains.js";
import type { HexString } from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  relayKeyReference,
  signRelayDigest,
  type RelayKeyReference,
  type RelaySessionKey,
} from "./sessionKey.js";

export type RelayCall = {
  data: HexString;
  to: HexString;
  value: bigint;
};

export type PreparedRelayCalls = {
  capabilities?: Record<string, unknown>;
  context: Record<string, unknown>;
  digest: HexString;
  key?: RelayKeyReference;
  signature: HexString;
  typedData: Record<string, unknown>;
};

export type RelaySendResult = {
  id: HexString;
};

export type RelayExecutionResult = RelaySendResult & {
  prepared: PreparedRelayCalls;
};

export type RelayJsonRpcClient = {
  request<T>(method: string, params: readonly unknown[]): Promise<T>;
};

export type FetchLike = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: "POST";
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type CreateRelayClientOptions = {
  fetch?: FetchLike;
};

export type SendRelayCallsOptions = {
  accountAddress: HexString;
  calls: readonly RelayCall[];
  client: RelayJsonRpcClient;
  network: Network;
  sessionKey: RelaySessionKey;
  signDigest?: (key: RelaySessionKey, digest: HexString) => Promise<HexString>;
};

export class RelayRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RelayRpcError";
  }
}

export function createRelayJsonRpcClient(
  relayUrl: string,
  options: CreateRelayClientOptions = {},
): RelayJsonRpcClient {
  const url = normalizeRelayUrl(relayUrl);
  const fetchFn: FetchLike | undefined =
    options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  let requestId = 0;

  if (fetchFn === undefined) {
    throw new CliError("fetch is not available in this Node runtime");
  }

  return {
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      requestId += 1;
      const response = await fetchFn(url, {
        body: JSON.stringify({
          id: requestId,
          jsonrpc: "2.0",
          method,
          params,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.text();

      if (!response.ok) {
        throw new RelayRpcError(
          `relay request failed with HTTP ${response.status}`,
        );
      }

      const parsed = parseJsonRpcResponse(body);
      if ("error" in parsed) {
        throw parsed.error;
      }

      return parsed.result as T;
    },
  };
}

export async function sendRelayCalls(
  options: SendRelayCallsOptions,
): Promise<RelayExecutionResult> {
  const prepared = await prepareRelayCalls(options.client, {
    accountAddress: options.accountAddress,
    calls: options.calls,
    network: options.network,
    sessionKey: options.sessionKey,
  });
  const signature = await (options.signDigest ?? signRelayDigest)(
    options.sessionKey,
    prepared.digest,
  );
  const sent = await sendPreparedRelayCalls(options.client, {
    prepared,
    sessionKey: options.sessionKey,
    signature,
  });

  return {
    id: sent.id,
    prepared,
  };
}

export async function prepareRelayCalls(
  client: RelayJsonRpcClient,
  options: {
    accountAddress: HexString;
    calls: readonly RelayCall[];
    network: Network;
    sessionKey: RelaySessionKey;
  },
): Promise<PreparedRelayCalls> {
  const chain = getChainConfig(options.network);
  const feeToken = options.sessionKey.permissions.spend[0]?.token;
  const meta = feeToken === undefined ? {} : { feeToken };
  const result = await client.request<unknown>("wallet_prepareCalls", [
    {
      calls: options.calls.map(encodeRelayCall),
      capabilities: {
        meta,
      },
      chainId: toRpcHex(chain.chainId),
      from: options.accountAddress,
      key: relayKeyReference(options.sessionKey),
    },
  ]);

  return parsePreparedRelayCalls(result);
}

export async function sendPreparedRelayCalls(
  client: RelayJsonRpcClient,
  options: {
    prepared: PreparedRelayCalls;
    sessionKey: RelaySessionKey;
    signature: HexString;
  },
): Promise<RelaySendResult> {
  const result = await client.request<unknown>("wallet_sendPreparedCalls", [
    {
      capabilities: extractSendCapabilities(options.prepared.capabilities),
      context: {
        preCall: options.prepared.context["preCall"],
        quote: options.prepared.context["quote"],
      },
      key: relayKeyReference(options.sessionKey),
      signature: options.signature,
    },
  ]);

  return parseRelaySendResult(result);
}

export function relayErrorToCliError(error: unknown): CliError {
  if (isUnauthorizedRelayError(error)) {
    return new CliError("permission not granted for delegated key");
  }

  const message =
    error instanceof Error && error.message.length > 0
      ? `relay execution failed: ${sanitizeRelayMessage(error.message)}`
      : "relay execution failed";

  return new CliError(message);
}

export function isUnauthorizedRelayError(error: unknown): boolean {
  const haystack = [
    error instanceof Error ? error.message : "",
    error instanceof RelayRpcError ? JSON.stringify(error.data) : "",
  ].join("\n");

  return /Unauthorized(Call|Spend|Key)|not authorized|unauthori[sz]ed|permission denied/i.test(
    haystack,
  );
}

function encodeRelayCall(call: RelayCall): Record<string, string> {
  return {
    data: call.data,
    to: call.to,
    value: toRpcHex(call.value),
  };
}

function extractSendCapabilities(
  capabilities: Record<string, unknown> | undefined,
): { feeSignature?: HexString } | undefined {
  const feeSignature = capabilities?.["feeSignature"];
  if (feeSignature === undefined) {
    return undefined;
  }
  assertNonEmptyHex(feeSignature, "relay fee signature must be hex");
  return { feeSignature };
}

function parsePreparedRelayCalls(value: unknown): PreparedRelayCalls {
  if (!isObject(value)) {
    throw new CliError("relay prepare response must be an object");
  }
  if (!isObject(value["context"])) {
    throw new CliError("relay prepare response context is invalid");
  }
  assertNonEmptyHex(
    value["digest"],
    "relay prepare response digest is invalid",
  );
  assertNonEmptyHex(
    value["signature"],
    "relay prepare response signature is invalid",
  );
  if (!isObject(value["typedData"])) {
    throw new CliError("relay prepare response typedData is invalid");
  }
  const capabilities = value["capabilities"];
  if (capabilities !== undefined && !isObject(capabilities)) {
    throw new CliError("relay prepare response capabilities is invalid");
  }

  return {
    capabilities,
    context: value["context"],
    digest: value["digest"],
    key: parseOptionalRelayKey(value["key"]),
    signature: value["signature"],
    typedData: value["typedData"],
  };
}

function parseRelaySendResult(value: unknown): RelaySendResult {
  if (!isObject(value)) {
    throw new CliError("relay send response must be an object");
  }
  assertNonEmptyHex(value["id"], "relay send response id is invalid");

  return {
    id: value["id"],
  };
}

function parseOptionalRelayKey(value: unknown): RelayKeyReference | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new CliError("relay prepare response key is invalid");
  }
  if (value["prehash"] !== false) {
    throw new CliError("relay prepare response key prehash is invalid");
  }
  if (value["type"] !== "secp256k1") {
    throw new CliError("relay prepare response key type is invalid");
  }
  assertNonEmptyHex(
    value["publicKey"],
    "relay prepare response key publicKey is invalid",
  );

  return {
    prehash: false,
    publicKey: value["publicKey"],
    type: "secp256k1",
  };
}

function parseJsonRpcResponse(body: string):
  | {
      result: unknown;
    }
  | {
      error: RelayRpcError;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new RelayRpcError("relay returned invalid JSON");
  }

  if (!isObject(parsed)) {
    throw new RelayRpcError("relay returned an invalid JSON-RPC response");
  }

  if (isObject(parsed["error"])) {
    const rpcError = parsed["error"];
    const message =
      typeof rpcError["message"] === "string" && rpcError["message"].length > 0
        ? rpcError["message"]
        : "relay JSON-RPC error";
    const code =
      typeof rpcError["code"] === "number" ? rpcError["code"] : undefined;

    return {
      error: new RelayRpcError(
        sanitizeRelayMessage(message),
        code,
        rpcError["data"],
      ),
    };
  }

  return {
    result: parsed["result"],
  };
}

function toRpcHex(value: bigint | number): HexString {
  const asBigInt = typeof value === "bigint" ? value : BigInt(value);
  if (asBigInt < 0n) {
    throw new CliError("relay numeric values must be non-negative");
  }

  return `0x${asBigInt.toString(16)}`;
}

function normalizeRelayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }

    return url.toString();
  } catch {
    throw new CliError("relay URL must be an HTTP(S) URL");
  }
}

function sanitizeRelayMessage(value: string): string {
  const firstLine = value.split("\n", 1)[0] ?? value;
  return firstLine.replace(
    /0x[0-9a-fA-F]{64,}/g,
    (match) => `${match.slice(0, 10)}...${match.slice(-6)}`,
  );
}

function assertNonEmptyHex(
  value: unknown,
  message: string,
): asserts value is HexString {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new CliError(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
