import { Key } from "porto";
import { createPublicClient, defineChain, http, parseAbi } from "viem";

import { getChainConfig, type Network } from "../config/chains.js";
import type { HexString, WalletKeyRecord } from "../config/profile.js";
import { CliError } from "../errors.js";

export type SpendPeriod = "minute" | "hour" | "day" | "week" | "month" | "year";

export type DelegatedSpendInfo = {
  current: string;
  currentSpent: string;
  lastUpdated: string;
  limit: string;
  period: SpendPeriod;
  remaining: string;
  spent: string;
  token: HexString;
};

export type ReadSpendInfosOptions = {
  accountAddress: HexString;
  key: WalletKeyRecord;
  network: Network;
};

const spendInfosAbi = parseAbi([
  "function spendInfos(bytes32 keyHash) view returns ((address token,uint8 period,uint256 limit,uint256 spent,uint256 lastUpdated,uint256 currentSpent,uint256 current)[] results)",
]);

export async function readSpendInfos(
  options: ReadSpendInfosOptions,
): Promise<DelegatedSpendInfo[]> {
  const config = getChainConfig(options.network);
  const client = createPublicClient({
    chain: defineChain({
      id: config.chainId,
      name: config.name,
      nativeCurrency: config.nativeCurrency,
      rpcUrls: {
        default: {
          http: [config.rpcUrl],
        },
      },
    }),
    transport: http(config.rpcUrl),
  });
  const keyHash = Key.fromSecp256k1({
    address: options.key.accessAddress,
    role: "session",
  }).hash;
  const infos = await client.readContract({
    abi: spendInfosAbi,
    address: options.accountAddress,
    args: [keyHash],
    functionName: "spendInfos",
  });

  return infos.map((info) => {
    const limit = info.limit;
    const currentSpent = info.currentSpent;
    const remaining = limit > currentSpent ? limit - currentSpent : 0n;

    return {
      current: info.current.toString(),
      currentSpent: currentSpent.toString(),
      lastUpdated: info.lastUpdated.toString(),
      limit: limit.toString(),
      period: parseSpendPeriod(info.period),
      remaining: remaining.toString(),
      spent: info.spent.toString(),
      token: info.token,
    };
  });
}

function parseSpendPeriod(value: number): SpendPeriod {
  switch (value) {
    case 0:
      return "minute";
    case 1:
      return "hour";
    case 2:
      return "day";
    case 3:
      return "week";
    case 4:
      return "month";
    case 5:
      return "year";
    default:
      throw new CliError(`unsupported on-chain spend period: ${value}`);
  }
}
