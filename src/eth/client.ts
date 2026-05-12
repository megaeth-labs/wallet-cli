import {
  createPublicClient,
  defineChain,
  http,
  isAddress,
  isHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { getChainConfig, type Network } from "../config/chains.js";
import { CliError } from "../errors.js";

export type HexString = `0x${string}`;
export type EthAddress = `0x${string}`;

export type EthCallRequest = {
  to: EthAddress;
  data: HexString;
  from?: EthAddress;
};

export type EthCallClient = {
  call(request: EthCallRequest): Promise<HexString>;
};

export type EthBalanceClient = {
  getBalance(address: EthAddress): Promise<bigint>;
};

export type EthReadClient = EthCallClient & EthBalanceClient;

export type ViemPublicCallClient = Pick<PublicClient, "call">;
export type ViemPublicReadClient = Pick<PublicClient, "call" | "getBalance">;

const defaultRpcUrls: Record<Network, string> = {
  mainnet: "https://mainnet.megaeth.com/rpc",
  testnet: "https://carrot.megaeth.com/rpc",
};

export function getDefaultRpcUrl(network: Network): string {
  return defaultRpcUrls[network];
}

export function createEthCallClient(
  network: Network,
  rpcUrl = getDefaultRpcUrl(network),
): EthCallClient {
  return fromViemPublicClient(createViemPublicClient(network, rpcUrl));
}

export function createEthReadClient(
  network: Network,
  rpcUrl = getDefaultRpcUrl(network),
): EthReadClient {
  return fromViemPublicReadClient(createViemPublicClient(network, rpcUrl));
}

function createViemPublicClient(
  network: Network,
  rpcUrl = getDefaultRpcUrl(network),
): PublicClient {
  const url = normalizeRpcUrl(rpcUrl);
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
        http: [rpcUrl],
      },
    },
  });

  return createPublicClient({
    chain,
    transport: http(url),
  });
}

export function fromViemPublicClient(
  client: ViemPublicCallClient,
): EthCallClient {
  return {
    async call(request: EthCallRequest): Promise<HexString> {
      const result = await client.call({
        ...(request.from === undefined
          ? {}
          : { account: request.from as Address }),
        data: request.data as Hex,
        to: request.to as Address,
      });

      return normalizeHexResult(result.data ?? "0x", "eth_call result");
    },
  };
}

export function fromViemPublicReadClient(
  client: ViemPublicReadClient,
): EthReadClient {
  return {
    ...fromViemPublicClient(client),
    async getBalance(address: EthAddress): Promise<bigint> {
      return client.getBalance({
        address: address as Address,
      });
    },
  };
}

export function normalizeAddress(value: unknown, label: string): EthAddress {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new CliError(`${label} must be a 20-byte hex address`);
  }

  return value as EthAddress;
}

export function normalizeHexResult(value: unknown, label: string): HexString {
  if (typeof value !== "string" || !isValidHexBytes(value)) {
    throw new CliError(`${label} must be a hex string`);
  }

  return value as HexString;
}

export function normalizeRpcUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }

    return url.toString();
  } catch {
    throw new CliError("RPC URL must be an HTTP(S) URL");
  }
}

export function isValidHexBytes(value: string): value is HexString {
  return isHex(value) && value.length % 2 === 0;
}
