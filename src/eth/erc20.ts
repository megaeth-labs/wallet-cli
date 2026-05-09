import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  parseUnits,
  type Hex,
} from "viem";

import { CliError } from "../errors.js";
import type { EthCallClient, HexString } from "./client.js";

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

export const erc20DecimalsAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export const erc20SymbolAbi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export type Erc20Metadata = {
  decimals: number;
  symbol?: string;
};

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

export async function readErc20Metadata(
  client: EthCallClient,
  token: `0x${string}`,
): Promise<Erc20Metadata> {
  const [decimals, symbol] = await Promise.all([
    readErc20Decimals(client, token),
    readErc20Symbol(client, token),
  ]);

  return symbol === undefined ? { decimals } : { decimals, symbol };
}

export async function readErc20Decimals(
  client: EthCallClient,
  token: `0x${string}`,
): Promise<number> {
  const data = await client.call({
    to: token,
    data: encodeFunctionData({
      abi: erc20DecimalsAbi,
      functionName: "decimals",
    }),
  });

  try {
    const result = decodeFunctionResult({
      abi: erc20DecimalsAbi,
      data: data as Hex,
      functionName: "decimals",
    });
    if (!Number.isSafeInteger(result) || result < 0 || result > 255) {
      throw new Error("invalid decimals");
    }

    return result;
  } catch {
    throw new CliError("ERC20 decimals() returned invalid data");
  }
}

export async function readErc20Symbol(
  client: EthCallClient,
  token: `0x${string}`,
): Promise<string | undefined> {
  let data: HexString;
  try {
    data = await client.call({
      to: token,
      data: encodeFunctionData({
        abi: erc20SymbolAbi,
        functionName: "symbol",
      }),
    });
  } catch {
    return undefined;
  }

  return decodeErc20Symbol(data);
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

function decodeErc20Symbol(data: HexString): string | undefined {
  if (data === "0x") {
    return undefined;
  }

  try {
    const decoded = decodeFunctionResult({
      abi: erc20SymbolAbi,
      data: data as Hex,
      functionName: "symbol",
    });
    return normalizeSymbol(decoded);
  } catch {
    return decodeBytes32Symbol(data);
  }
}

function decodeBytes32Symbol(data: HexString): string | undefined {
  try {
    const [bytes] = decodeAbiParameters([{ type: "bytes32" }], data as Hex);
    if (typeof bytes !== "string") {
      return undefined;
    }

    const hex = bytes.slice(2).replace(/(?:00)+$/u, "");
    if (hex.length === 0) {
      return undefined;
    }

    return normalizeSymbol(Buffer.from(hex, "hex").toString("utf8"));
  } catch {
    return undefined;
  }
}

function normalizeSymbol(value: string): string | undefined {
  const symbol = value.replace(/\0+$/u, "").trim();

  return symbol.length === 0 ? undefined : symbol;
}
