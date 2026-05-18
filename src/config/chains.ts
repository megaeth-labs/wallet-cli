export const networks = ["mainnet", "testnet"] as const;

export type Network = (typeof networks)[number];

export const defaultNetwork = "mainnet" satisfies Network;

export type HexAddress = `0x${string}`;

export type ChainConfig = {
  network: Network;
  chainId: number;
  name: string;
  nativeCurrency: {
    decimals: number;
    name: string;
    symbol: string;
  };
  rpcUrl: string;
  walletUrl: string;
  walletApiUrl: string;
  relayUrl: string;
  defaultFeeToken: {
    address: HexAddress;
    decimals: number;
    symbol: "USDM";
  };
};

const walletUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_WALLET_URL");
const walletApiUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_WALLET_API_URL");
const relayUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_RELAY_URL");
const defaultWalletUrl = "https://account.megaeth.com";
const defaultWalletApiUrl = "https://wallet-api.megaeth.com";
const defaultRelayUrl = "https://wallet-relay.megaeth.com";
const nativeCurrency = {
  decimals: 18,
  name: "MegaETH Ether",
  symbol: "ETH",
} satisfies ChainConfig["nativeCurrency"];

export const chainConfigs: Record<Network, ChainConfig> = {
  mainnet: {
    network: "mainnet",
    chainId: 4326,
    name: "MegaETH Mainnet",
    nativeCurrency,
    rpcUrl: "https://mainnet.megaeth.com/rpc",
    walletUrl: walletUrlOverride ?? defaultWalletUrl,
    walletApiUrl: walletApiUrlOverride ?? defaultWalletApiUrl,
    relayUrl: relayUrlOverride ?? defaultRelayUrl,
    defaultFeeToken: {
      address: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
      decimals: 18,
      symbol: "USDM",
    },
  },
  testnet: {
    network: "testnet",
    chainId: 6343,
    name: "MegaETH Testnet",
    nativeCurrency,
    rpcUrl: "https://carrot.megaeth.com/rpc",
    walletUrl: walletUrlOverride ?? defaultWalletUrl,
    walletApiUrl: walletApiUrlOverride ?? defaultWalletApiUrl,
    relayUrl: relayUrlOverride ?? defaultRelayUrl,
    defaultFeeToken: {
      address: "0x15e9f2b0a747ac05c7446559306687085d161e5c",
      decimals: 18,
      symbol: "USDM",
    },
  },
};

export function isNetwork(value: string): value is Network {
  return networks.includes(value as Network);
}

export function getChainConfig(network: Network): ChainConfig {
  return chainConfigs[network];
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}
