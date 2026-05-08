import type { HexString } from "../config/profile.js";
import { CliError } from "../errors.js";
import type { RelayJsonRpcClient } from "./sendCalls.js";

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
  client: RelayJsonRpcClient;
  id: HexString;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const defaultIntervalMs = 1_000;
const defaultTimeoutMs = 120_000;

export async function getRelayCallsStatus(
  client: RelayJsonRpcClient,
  id: HexString,
): Promise<RelayCallsStatus> {
  const result = await client.request<unknown>("wallet_getCallsStatus", [id]);
  return parseRelayCallsStatus(result);
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
    const status = await getRelayCallsStatus(options.client, options.id);
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

function parseRelayCallsStatus(value: unknown): RelayCallsStatus {
  if (!isObject(value)) {
    throw new CliError("relay status response must be an object");
  }
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CliError("relay status response id is invalid");
  }

  const receipts = value["receipts"];
  const parsed: RelayCallsStatus = {
    id,
    status: parseRpcNumber(value["status"], "relay status code is invalid"),
  };
  if (receipts !== undefined) {
    if (!Array.isArray(receipts)) {
      throw new CliError("relay status receipts must be an array");
    }
    parsed.receipts = receipts.map(parseRelayReceipt);
  }

  return parsed;
}

function parseRelayReceipt(value: unknown): RelayReceipt {
  if (!isObject(value)) {
    throw new CliError("relay status receipt must be an object");
  }
  const logs = value["logs"];
  if (!Array.isArray(logs)) {
    throw new CliError("relay status receipt logs must be an array");
  }

  return {
    blockHash: parseHex(value["blockHash"], "receipt blockHash is invalid"),
    blockNumber: parseRpcNumber(
      value["blockNumber"],
      "receipt blockNumber is invalid",
    ),
    chainId: parseRpcNumber(value["chainId"], "receipt chainId is invalid"),
    gasUsed: parseRpcNumber(value["gasUsed"], "receipt gasUsed is invalid"),
    logs: logs.map(parseRelayReceiptLog),
    status: parseHex(value["status"], "receipt status is invalid"),
    transactionHash: parseHex(
      value["transactionHash"],
      "receipt transactionHash is invalid",
    ),
  };
}

function parseRelayReceiptLog(value: unknown): RelayReceiptLog {
  if (!isObject(value)) {
    throw new CliError("relay status receipt log must be an object");
  }
  const topics = value["topics"];
  if (!Array.isArray(topics)) {
    throw new CliError("relay status receipt log topics must be an array");
  }

  return {
    address: parseHex(value["address"], "receipt log address is invalid"),
    data: parseHex(value["data"], "receipt log data is invalid", true),
    topics: topics.map((topic) =>
      parseHex(topic, "receipt log topic is invalid"),
    ),
  };
}

function parseRpcNumber(value: unknown, message: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    const parsed = Number.parseInt(value.slice(2), 16);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new CliError(message);
}

function parseHex(
  value: unknown,
  message: string,
  allowEmpty = false,
): HexString {
  const pattern = allowEmpty ? /^0x[0-9a-fA-F]*$/ : /^0x[0-9a-fA-F]+$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new CliError(message);
  }

  return value as HexString;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
