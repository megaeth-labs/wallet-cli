import * as IntentActions from "@megaeth-labs/wallet-intent";
import { Account } from "porto";
import { createClient, defineChain, http, zeroAddress } from "viem";
import type { Address, Call, Hex } from "viem";

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

export type RelayExecutionResult = {
  id: HexString;
  receipts: RelayCallsStatus["receipts"];
  status: number;
  transactionHash: HexString;
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

export type RelayPaymentPerGasToken = {
  address: HexString;
  feeToken?: boolean;
  paymentPerGas?: HexString | null;
  symbol: string;
};

export type RelayPaymentPerGasEntry = {
  tokens: readonly RelayPaymentPerGasToken[];
};

export type PortoRelayActions = {
  sendCalls(
    client: PortoRelayClient,
    parameters: IntentActions.SendCallsInput,
  ): Promise<IntentActions.SendCallsResult>;
  getPaymentPerGas(client: PortoRelayClient): Promise<RelayPaymentPerGasEntry>;
  getKeys?(
    client: PortoRelayClient,
    parameters: { account: HexString; chainIds?: readonly number[] },
  ): Promise<readonly RelayAccountKey[]>;
};

export type SendRelayCallsOptions = {
  accountAddress: HexString;
  actions?: PortoRelayActions;
  calls: readonly RelayCall[];
  client: PortoRelayClient;
  network: Network;
  sessionKey: RelaySessionKey;
};

export const portoRelayActions: PortoRelayActions = {
  getKeys: IntentActions.getKeys,
  getPaymentPerGas: IntentActions.getPaymentPerGas,
  sendCalls: IntentActions.sendCalls,
};

export function createPortoRelayClient(
  relayUrl: string,
  network: Network,
): PortoRelayClient {
  const config = getChainConfig(network);
  const url = resolvePortoRelayUrl(relayUrl, network);
  const chain = defineChain({
    id: config.chainId,
    name: config.name,
    nativeCurrency: config.nativeCurrency,
    rpcUrls: {
      default: {
        http: [isLoopbackUrl(url) ? url : config.rpcUrl],
      },
    },
  });

  return createClient({
    chain,
    pollingInterval: 1_000,
    transport: http(url),
  });
}

export function resolvePortoRelayUrl(
  relayUrl: string,
  network: Network,
): string {
  return resolveRelayUrl(relayUrl, getChainConfig(network).relayUrl);
}

function resolveRelayUrl(
  relayUrl: string,
  currentDefaultRelayUrl: string,
): string {
  const url = normalizeRelayUrl(relayUrl);
  if (url === normalizeRelayUrl("https://wallet-relay.megaeth.com")) {
    return normalizeRelayUrl(currentDefaultRelayUrl);
  }

  return url;
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

  const receipt = await actions.sendCalls(options.client, {
    account: Account.from({
      address: options.accountAddress as Address,
      keys: [options.sessionKey],
    }),
    calls: options.calls.map(toViemCall),
    ...(feeToken === undefined ? {} : { feeToken: feeToken as Address }),
    key: options.sessionKey,
  });
  const normalizedReceipt = normalizeRelayReceipt(receipt, options.network);

  return {
    id: normalizedReceipt.transactionHash,
    receipts: [normalizedReceipt],
    status: isReceiptSuccess(receipt.status) ? 200 : 500,
    transactionHash: normalizedReceipt.transactionHash,
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
  if (
    symbol === undefined ||
    symbol.length === 0 ||
    isNativeFeeSymbol(symbol)
  ) {
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
  const paymentPerGas = await options.actions.getPaymentPerGas(options.client);
  const tokens = paymentPerGas.tokens;
  return tokens.find(
    (token) =>
      token.feeToken !== false &&
      token.symbol.toLowerCase() === symbol.toLowerCase(),
  );
}

function toViemCall(call: RelayCall): Call {
  return {
    data: call.data as Hex,
    to: call.to as Address,
    value: call.value,
  };
}

function normalizeRelayReceipt(
  receipt: IntentActions.SendCallsResult,
  network: Network,
): NonNullable<RelayCallsStatus["receipts"]>[number] {
  const config = getChainConfig(network);

  return {
    blockHash: receipt.blockHash as HexString,
    blockNumber: quantityToNumber(receipt.blockNumber, "blockNumber"),
    chainId:
      receipt.chainId === undefined
        ? config.chainId
        : quantityToNumber(receipt.chainId, "chainId"),
    gasUsed: quantityToNumber(receipt.gasUsed, "gasUsed"),
    logs: receipt.logs.map((log) => ({
      address: log.address as HexString,
      data: log.data as HexString,
      topics: log.topics as HexString[],
    })),
    status: normalizeReceiptStatus(receipt.status),
    transactionHash: receipt.transactionHash as HexString,
  };
}

function quantityToNumber(
  value: HexString | Hex | number,
  label: string,
): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CliError(`relay receipt ${label} is not a safe integer`);
  }

  return parsed;
}

function normalizeReceiptStatus(value: HexString | Hex | string): HexString {
  if (value === "success") return "0x1";
  if (value === "reverted" || value === "failure") return "0x0";
  if (/^0x[0-9a-fA-F]+$/.test(value)) return value as HexString;

  return "0x0";
}

function isReceiptSuccess(value: HexString | Hex | string): boolean {
  return normalizeReceiptStatus(value) === "0x1";
}

function isNativeFeeSymbol(symbol: string): boolean {
  return symbol.toLowerCase() === "eth" || symbol.toLowerCase() === "native";
}

function isLoopbackUrl(value: string): boolean {
  const { hostname } = new URL(value);
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
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
