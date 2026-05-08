import { encodeFunctionData, parseUnits } from "viem";

import { CliError } from "../errors.js";
import type { HexString } from "./client.js";

export const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const decimalAmountPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function encodeErc20TransferCall(
  to: `0x${string}`,
  amount: bigint,
): HexString {
  return encodeFunctionData({
    abi: erc20TransferAbi,
    args: [to, amount],
    functionName: "transfer",
  });
}

export function parseDecimalUnits(
  value: unknown,
  decimals: number,
  label: string,
): bigint {
  if (typeof value !== "string") {
    throw new CliError(`${label} must be a positive decimal amount`);
  }

  const amount = value.trim();
  if (!decimalAmountPattern.test(amount)) {
    throw new CliError(`${label} must be a positive decimal amount`);
  }

  const fractional = amount.split(".", 2)[1] ?? "";
  if (fractional.length > decimals) {
    throw new CliError(`${label} has more than ${decimals} decimal places`);
  }

  const units = parseUnits(amount, decimals);
  if (units <= 0n) {
    throw new CliError(`${label} must be greater than zero`);
  }

  return units;
}
