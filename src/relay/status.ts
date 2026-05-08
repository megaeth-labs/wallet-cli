import type { HexString } from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  portoRelayActions,
  type PortoRelayActions,
  type PortoRelayClient,
} from "./sendCalls.js";

export const pendingRelayStatuses = new Set([100, 201]);

export type RelayReceiptLog = {
  address: HexString;
  data: HexString;
  topics: HexString[];
};

export type RelayReceipt = {
  blockHash: HexString;
  blockNumber: number;
  chainId: number;
  gasUsed: number;
  logs: RelayReceiptLog[];
  status: HexString;
  transactionHash: HexString;
};

export type RelayCallsStatus = {
  id: string;
  receipts?: RelayReceipt[];
  status: number;
};

export type PollCallsStatusOptions = {
  actions?: PortoRelayActions;
  client: PortoRelayClient;
  id: HexString;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const defaultIntervalMs = 1_000;
const defaultTimeoutMs = 120_000;

export async function getRelayCallsStatus(
  client: PortoRelayClient,
  id: HexString,
  actions: PortoRelayActions = portoRelayActions,
): Promise<RelayCallsStatus> {
  return actions.getCallsStatus(client, { id });
}

export async function pollRelayCallsStatus(
  options: PollCallsStatusOptions,
): Promise<RelayCallsStatus> {
  const intervalMs = normalizePositiveInteger(
    options.intervalMs ?? defaultIntervalMs,
    "poll interval must be a positive integer",
  );
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs ?? defaultTimeoutMs,
    "poll timeout must be a positive integer",
  );
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    const status = await getRelayCallsStatus(
      options.client,
      options.id,
      options.actions,
    );
    if (!pendingRelayStatuses.has(status.status)) {
      return status;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new CliError(`relay call bundle timed out after ${timeoutMs}ms`);
    }

    await sleep(Math.min(intervalMs, remaining));
  }
}

export function isSuccessfulRelayStatus(status: number): boolean {
  return status < 300;
}

function normalizePositiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(message);
  }

  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
