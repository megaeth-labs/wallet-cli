import { RelayActions } from "porto";
import { createClient, defineChain, http } from "viem";

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

export type PortoRelayClient = unknown;

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
};

export type SendRelayCallsOptions = {
  accountAddress: HexString;
  actions?: PortoRelayActions;
  calls: readonly RelayCall[];
  client: PortoRelayClient;
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
    name: network === "mainnet" ? "MegaETH Mainnet" : "MegaETH Testnet",
    nativeCurrency: {
      decimals: 18,
      name: "MegaETH Ether",
      symbol: "ETH",
    },
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
  const feeToken = options.sessionKey.permissions?.spend?.[0]?.token;
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
    object["shortMessage"],
    object["details"],
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
