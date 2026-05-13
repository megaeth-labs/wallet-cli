export const networks = ["mainnet"] as const;

export type Network = (typeof networks)[number];

export const defaultNetwork = "mainnet" satisfies Network;

export type ChainConfig = {
  network: Network;
  chainId: number;
  walletUrl: string;
  walletApiUrl: string;
  relayUrl: string;
};

const walletUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_WALLET_URL");
const walletApiUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_WALLET_API_URL");
const relayUrlOverride = readOptionalEnv("MEGA_WALLET_CLI_RELAY_URL");
const defaultWalletUrl = "https://account.megaeth.com";

export const chainConfigs: Record<Network, ChainConfig> = {
  mainnet: {
    network: "mainnet",
    chainId: 4326,
    walletUrl: walletUrlOverride ?? defaultWalletUrl,
    walletApiUrl: walletApiUrlOverride ?? "https://wallet-api.megaeth.com",
    relayUrl: relayUrlOverride ?? "https://wallet-relay.megaeth.com",
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
