import type { Network } from "../config/chains.js";
import { getActiveWalletKey, readWalletProfile } from "../config/profile.js";
import { CliError } from "../errors.js";
import {
  createEthCallClient,
  getDefaultRpcUrl,
  normalizeAddress,
  normalizeRpcUrl,
  type EthCallClient,
} from "../eth/client.js";
import {
  encodeErc20TransferCall,
  parseDecimalUnits,
  readErc20Metadata,
  type Erc20Metadata,
} from "../eth/erc20.js";
import { normalizeNetwork } from "../commands/common.js";
import type { TransferCommandDependencies, TransferDetails } from "../commands/transfer.js";
import type { WalletCommandDependencies } from "../commands/wallet.js";

export type TransferPreviewInput = {
  amount?: string;
  decimals?: number;
  key?: string;
  network?: string;
  rpcUrl?: string;
  to?: string;
  token?: string;
};

export type TransferPreviewResult = {
  network: Network;
  accountAddress: `0x${string}`;
  readiness: "ready" | "needs_key";
  activeKey?: {
    id: `0x${string}`;
    accessAddress: `0x${string}`;
    expiry: number;
  };
  requestedKey?: string;
  transfer: TransferDetails;
  call: {
    to: `0x${string}`;
    value: string;
    data: `0x${string}`;
  };
  warnings: string[];
};

export async function buildTransferPlan(
  options: TransferPreviewInput,
  dependencies: TransferCommandDependencies | WalletCommandDependencies = {},
): Promise<TransferPreviewResult> {
  const network = normalizeNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const activeKey = getActiveWalletKey(profile);
  const transfer = await buildTransfer(options, network, dependencies as TransferCommandDependencies);

  return {
    network,
    accountAddress: profile.accountAddress,
    readiness: activeKey === undefined ? "needs_key" : "ready",
    ...(activeKey === undefined
      ? {}
      : {
          activeKey: {
            id: activeKey.id,
            accessAddress: activeKey.accessAddress,
            expiry: activeKey.authorizedKey.expiry,
          },
        }),
    ...(options.key === undefined ? {} : { requestedKey: options.key }),
    transfer: transfer.details,
    call: {
      to: transfer.call.to,
      value: transfer.call.value.toString(),
      data: transfer.call.data,
    },
    warnings:
      activeKey === undefined
        ? [
            profile.keys.length === 0
              ? "No delegated keys exist yet; run mega moss create-key before execution."
              : "No usable default delegated key is selected; switch or create a key before execution.",
          ]
        : [],
  };
}

async function buildTransfer(
  options: TransferPreviewInput,
  network: Network,
  dependencies: TransferCommandDependencies,
): Promise<{
  call: { data: `0x${string}`; to: `0x${string}`; value: bigint };
  details: TransferDetails;
}> {
  const amount = normalizeAmount(options.amount);
  const recipient = normalizeAddress(options.to, "transfer recipient");

  if (options.token === undefined) {
    if (options.decimals !== undefined) {
      throw new CliError("--decimals can only be used with --token");
    }

    const value = parseDecimalUnits(amount, 18, "transfer amount");

    return {
      call: {
        data: "0x",
        to: recipient,
        value,
      },
      details: {
        amount,
        asset: "native",
        to: recipient,
        value: value.toString(),
      },
    };
  }

  const token = normalizeAddress(options.token, "ERC20 token");
  const metadata = await resolveTokenMetadata(options, network, token, dependencies);
  const units = parseDecimalUnits(amount, metadata.decimals, "transfer amount");

  return {
    call: {
      data: encodeErc20TransferCall(recipient, units),
      to: token,
      value: 0n,
    },
    details: {
      amount,
      asset: "erc20",
      decimals: metadata.decimals,
      to: recipient,
      token,
      units: units.toString(),
      ...(metadata.symbol === undefined ? {} : { symbol: metadata.symbol }),
    },
  };
}

async function resolveTokenMetadata(
  options: Pick<TransferPreviewInput, "decimals" | "rpcUrl">,
  network: Network,
  token: `0x${string}`,
  dependencies: TransferCommandDependencies,
): Promise<Erc20Metadata> {
  if (options.decimals !== undefined) {
    return { decimals: options.decimals };
  }

  const rpcUrl = normalizeRpcUrl(options.rpcUrl ?? getDefaultRpcUrl(network));
  const readMetadata =
    dependencies.readTokenMetadata ??
    ((metadataOptions: { network: Network; rpcUrl: string; token: `0x${string}` }) => {
      const client: EthCallClient =
        dependencies.createTokenClient?.(metadataOptions.network, metadataOptions.rpcUrl) ??
        createEthCallClient(metadataOptions.network, metadataOptions.rpcUrl);
      return readErc20Metadata(client, metadataOptions.token);
    });

  try {
    return await readMetadata({ network, rpcUrl, token });
  } catch (error) {
    const suffix = error instanceof Error && error.message.length > 0 ? `: ${firstLine(error.message)}` : "";
    throw new CliError(`failed to read ERC20 decimals; pass --decimals or --rpc-url${suffix}`);
  }
}

function normalizeAmount(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CliError("transfer amount is required");
  }

  return value.trim();
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}
