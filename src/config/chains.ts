export const networks = ["mainnet", "testnet"] as const;

export type Network = (typeof networks)[number];

export type ChainConfig = {
  network: Network;
  chainId: number;
  walletUrl: string;
  relayUrl: string;
};

export const chainConfigs: Record<Network, ChainConfig> = {
  mainnet: {
    network: "mainnet",
    chainId: 6342,
    walletUrl: "https://wallet.megaeth.com",
    relayUrl: "https://relay.megaeth.com",
  },
  testnet: {
    network: "testnet",
    chainId: 6342,
    walletUrl: "https://testnet-wallet.megaeth.com",
    relayUrl: "https://testnet-relay.megaeth.com",
  },
};

export function isNetwork(value: string): value is Network {
  return networks.includes(value as Network);
}

export function getChainConfig(network: Network): ChainConfig {
  return chainConfigs[network];
}
