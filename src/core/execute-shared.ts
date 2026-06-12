import { normalizeAddress, normalizeHexResult } from "../eth/client.js";
import { CliError } from "../errors.js";
import type { ExecuteCallInput } from "../commands/execute.js";
import type { RelayCall } from "../relay/sendCalls.js";

export function normalizeExecuteCalls(calls: readonly ExecuteCallInput[]): RelayCall[] {
  if (calls.length === 0) {
    throw new CliError("provide at least one call to execute");
  }

  return calls.map((call) => ({
    data: normalizeHexResult(call.data ?? "0x", "execute call data"),
    to: normalizeAddress(call.to, "execute target"),
    value: normalizeExecuteValue(call.value ?? "0"),
  }));
}

function normalizeExecuteValue(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new CliError("execute value must be non-negative");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new CliError("execute value must be a non-negative integer");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]+$/.test(value) || /^\d+$/.test(value)) {
      return BigInt(value);
    }
  }
  throw new CliError("execute value must be a non-negative integer");
}
