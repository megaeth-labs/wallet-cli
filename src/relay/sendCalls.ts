import { RelayActions } from "porto";
import { createClient, defineChain, http, zeroAddress } from "viem";

import { getChainConfig, type Network } from "../config/chains.js";
import type { HexString } from "../config/profile.js";
import { CliError } from "../errors.js";
import type { RelayCallsStatus } from "./status.js";
import type { RelaySessionKey } from "./sessionKey.js";

export type RelayCall = {
  data: HexString;
  to: HexString;
  value: bigint;
};

export type PreparedRelayCalls = {
  capabilities?: unknown;
  context: unknown;
  digest: HexString;
  key?: unknown;
};

export type RelaySendResult = {
  id: HexString;
};

export type RelayExecutionResult = RelaySendResult & {
  prepared: PreparedRelayCalls;
  signature: HexString;
};

export type RelayAccountKey = {
  expiry?: unknown;
  hash?: unknown;
  id?: unknown;
  publicKey?: unknown;
  role?: unknown;
};

export type PortoRelayClient = unknown;

export type RelayFeeTokenCapability = {
  address: HexString;
  feeToken?: boolean;
  symbol: string;
};

export type RelayCapabilities = {
  fees?: {
    tokens?: readonly RelayFeeTokenCapability[];
  };
};

export type PortoRelayActions = {
  prepareCalls(
    client: PortoRelayClient,
    parameters: {
      account: HexString;
      calls: readonly RelayCall[];
      feeToken?: HexString;
      key: RelaySessionKey;
    },
  ): Promise<PreparedRelayCalls>;
  signCalls(
    prepared: PreparedRelayCalls,
    parameters: { key: RelaySessionKey },
  ): Promise<HexString>;
  sendPreparedCalls(
    client: PortoRelayClient,
    parameters: PreparedRelayCalls & { signature: HexString },
  ): Promise<RelaySendResult>;
  getCallsStatus(
    client: PortoRelayClient,
    parameters: { id: HexString },
  ): Promise<RelayCallsStatus>;
  getKeys?(
    client: PortoRelayClient,
    parameters: { account: HexString; chainIds?: readonly number[] },
  ): Promise<readonly RelayAccountKey[]>;
  getCapabilities?(
    client: PortoRelayClient,
    parameters: { chainId?: number },
  ): Promise<RelayCapabilities>;
};

export type SendRelayCallsOptions = {
  accountAddress: HexString;
  actions?: PortoRelayActions;
  calls: readonly RelayCall[];
  client: PortoRelayClient;
  network: Network;
  sessionKey: RelaySessionKey;
};

export const portoRelayActions = RelayActions as unknown as PortoRelayActions;

export function createPortoRelayClient(
  relayUrl: string,
  network: Network,
): PortoRelayClient {
  const url = normalizeRelayUrl(relayUrl);
  const config = getChainConfig(network);
  const chain = defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: {
      default: {
        http: [url],
      },
    },
  });

  return createClient({
    chain,
    pollingInterval: 1_000,
    transport: http(url),
  });
}

export async function sendRelayCalls(
  options: SendRelayCallsOptions,
): Promise<RelayExecutionResult> {
  const actions = options.actions ?? portoRelayActions;
  const feeToken = await resolveApprovedFeeTokenAddress({
    actions,
    client: options.client,
    network: options.network,
    sessionKey: options.sessionKey,
  });
  const prepared = await actions.prepareCalls(options.client, {
    account: options.accountAddress,
    calls: options.calls,
    ...(feeToken === undefined ? {} : { feeToken }),
    key: options.sessionKey,
  });
  const signature = await actions.signCalls(prepared, {
    key: options.sessionKey,
  });
  const sent = await actions.sendPreparedCalls(options.client, {
    ...prepared,
    signature,
  });

  return {
    id: sent.id,
    prepared,
    signature,
  };
}

async function resolveApprovedFeeTokenAddress(options: {
  actions: PortoRelayActions;
  client: PortoRelayClient;
  network: Network;
  sessionKey: RelaySessionKey;
}): Promise<HexString | undefined> {
  const feeToken = options.sessionKey.feeToken;
  if (feeToken === undefined || feeToken === null) {
    return undefined;
  }

  const symbol = feeToken.symbol?.trim();
  if (symbol === undefined || symbol.length === 0 || isNativeFeeSymbol(symbol)) {
    return zeroAddress;
  }

  const config = getChainConfig(options.network);
  const capability = await findRelayFeeToken(options, symbol, config.chainId);
  if (capability !== undefined) {
    return capability.address;
  }

  if (symbol.toLowerCase() === config.defaultFeeToken.symbol.toLowerCase()) {
    return config.defaultFeeToken.address;
  }

  throw new CliError(
    `approved fee token ${symbol} is not supported by ${config.name}`,
  );
}

async function findRelayFeeToken(
  options: {
    actions: PortoRelayActions;
    client: PortoRelayClient;
  },
  symbol: string,
  chainId: number,
): Promise<RelayFeeTokenCapability | undefined> {
  const capabilities = await options.actions.getCapabilities?.(options.client, {
    chainId,
  });
  const tokens = capabilities?.fees?.tokens ?? [];
  return tokens.find(
    (token) =>
      token.feeToken !== false &&
      token.symbol.toLowerCase() === symbol.toLowerCase(),
  );
}

function isNativeFeeSymbol(symbol: string): boolean {
  return symbol.toLowerCase() === "eth" || symbol.toLowerCase() === "native";
}

export function relayErrorToCliError(error: unknown): CliError {
  if (isUnauthorizedRelayError(error)) {
    return new CliError("permission not granted for delegated key");
  }

  const detail = relayErrorDetail(error);
  const message =
    detail === undefined
      ? "relay execution failed"
      : `relay execution failed: ${detail}`;

  return new CliError(message);
}

export function isUnauthorizedRelayError(error: unknown): boolean {
  return /Unauthorized(Call|Spend|Key)|not authorized|unauthori[sz]ed|permission denied/i.test(
    collectErrorText(error),
  );
}

function collectErrorText(error: unknown, depth = 0): string {
  if (depth > 3 || error === undefined || error === null) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return [
      error.message,
      collectObjectText(error, depth),
      collectErrorText(error.cause, depth + 1),
    ].join("\n");
  }

  if (typeof error === "object") {
    return collectObjectText(error, depth);
  }

  return "";
}

function collectObjectText(error: object, depth: number): string {
  const object = error as Record<string, unknown>;
  const values = [
    object["message"],
    object["shortMessage"],
    object["details"],
    object["reason"],
    object["error"],
    object["data"],
    object["cause"],
  ];

  return values
    .map((value) =>
      typeof value === "string"
        ? value
        : value === undefined
          ? ""
          : collectErrorText(value, depth + 1),
    )
    .join("\n");
}

function relayErrorDetail(error: unknown): string | undefined {
  const lines = collectErrorText(error)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const selected =
    lines.find((line) => !isGenericRelayErrorLine(line)) ?? lines[0];

  return selected === undefined ? undefined : sanitizeRelayMessage(selected);
}

function isGenericRelayErrorLine(line: string): boolean {
  return /^(An error occurred while executing calls|Execution reverted for an unknown reason)\.?$/i.test(
    line,
  );
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
