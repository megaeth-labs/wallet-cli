import { zeroAddress } from "viem";

import { normalizeNetwork } from "../commands/common.js";
import { evaluateDelegatedKeyCapability, type CapabilityIssue } from "./capability.js";
import type { StatusCommandOptions, ListCommandOptions, WalletCommandDependencies, WalletListResult, WalletStatusResult, RenderedWalletKey } from "../commands/wallet.js";
import { summarizeAuthorizedKey, type TokenDisplayMetadataMap } from "../config/permissionSummary.js";
import { getActiveWalletKey, readWalletProfile, summarizeProfile, type HexString, type WalletKeyRecord, type WalletProfile } from "../config/profile.js";
import { createEthCallClient } from "../eth/client.js";
import { readErc20Metadata } from "../eth/erc20.js";
import type { DelegatedSpendInfo } from "../relay/spendInfo.js";

export async function getWalletStatus(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletStatusResult> {
  const network = normalizeNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const activeKey = getActiveWalletKey(profile);
  const tokenMetadata =
    activeKey === undefined || options.terse || options.json
      ? {}
      : await loadTokenMetadataForStatus([activeKey], undefined, network, dependencies);

  return buildStatusResult(profile, getNow(dependencies), tokenMetadata);
}

export async function getWalletList(
  options: ListCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletListResult> {
  const network = normalizeNetwork(options.network);
  const profile = await readWalletProfile(network, dependencies.env);
  const now = getNow(dependencies);
  const keys = sortKeysByRecency(profile.keys)
    .map((key) => renderableKey(profile, key, now))
    .filter(
      (key) =>
        options.showInactive ||
        (key.effectiveStatus === "active" && key.status === "active"),
    );

  return {
    accountAddress: profile.accountAddress,
    ...(profile.activeKeyId === undefined
      ? {}
      : { activeKeyId: profile.activeKeyId }),
    keys,
    network,
  };
}

export function buildStatusResult(
  profile: WalletProfile,
  now: Date,
  tokenMetadata: TokenDisplayMetadataMap = {},
): WalletStatusResult {
  const activeKey = getActiveWalletKey(profile);
  const summary = summarizeProfile(profile);

  return {
    ...summary,
    ...(activeKey === undefined
      ? {}
      : {
          activeKey: renderableKey(profile, activeKey, now),
          permissionLines: summarizeAuthorizedKey(
            activeKey.authorizedKey,
            tokenMetadata,
          ).lines,
        }),
    ...(Object.keys(tokenMetadata).length === 0 ? {} : { tokenMetadata }),
  };
}

export function renderableKey(
  profile: WalletProfile,
  key: WalletKeyRecord,
  now: Date,
): RenderedWalletKey {
  const expired = isWalletKeyExpired(key, now);
  const active =
    profile.activeKeyId !== undefined &&
    key.id.toLowerCase() === profile.activeKeyId.toLowerCase();

  return {
    ...key,
    active,
    expired,
    expiresAt: new Date(key.authorizedKey.expiry * 1000).toISOString(),
    effectiveStatus:
      key.status === "revoked" ? "revoked" : expired ? "expired" : "active",
  };
}

function isWalletKeyExpired(key: WalletKeyRecord, now = new Date()): boolean {
  return key.authorizedKey.expiry * 1000 <= now.getTime();
}

function sortKeysByRecency(keys: readonly WalletKeyRecord[]): WalletKeyRecord[] {
  return [...keys].sort((left, right) => {
    const leftTime = Date.parse(left.lastUsedAt ?? left.updatedAt);
    const rightTime = Date.parse(right.lastUsedAt ?? right.updatedAt);
    return rightTime - leftTime;
  });
}

function getNow(dependencies: WalletCommandDependencies): Date {
  return (dependencies.now ?? (() => new Date()))();
}

export async function loadTokenMetadataForStatus(
  keys: readonly WalletKeyRecord[],
  spendInfos: readonly DelegatedSpendInfo[] | undefined,
  network: "mainnet" | "testnet",
  dependencies: WalletCommandDependencies,
): Promise<TokenDisplayMetadataMap> {
  const tokens = collectSpendTokens(keys, spendInfos);
  if (tokens.length === 0) {
    return {};
  }

  try {
    return await (
      dependencies.readTokenMetadata ?? readPermissionTokenMetadata
    )({
      network,
      tokens,
    });
  } catch {
    return {};
  }
}

function collectSpendTokens(
  keys: readonly WalletKeyRecord[],
  spendInfos: readonly DelegatedSpendInfo[] | undefined,
): HexString[] {
  const tokens = new Set<HexString>();
  for (const key of keys) {
    for (const spend of key.authorizedKey.permissions.spend) {
      addMetadataToken(tokens, spend.token);
    }
  }
  for (const info of spendInfos ?? []) {
    addMetadataToken(tokens, info.token);
  }

  return [...tokens];
}

function addMetadataToken(
  tokens: Set<HexString>,
  token: HexString | undefined,
): void {
  if (token === undefined || token.toLowerCase() === zeroAddress) {
    return;
  }

  tokens.add(token.toLowerCase() as HexString);
}

async function readPermissionTokenMetadata(options: {
  network: "mainnet" | "testnet";
  tokens: readonly HexString[];
}): Promise<TokenDisplayMetadataMap> {
  const client = createEthCallClient(options.network);
  const entries = await Promise.all(
    options.tokens.map(async (token) => {
      try {
        return [
          token.toLowerCase(),
          await readErc20Metadata(client, token),
        ] as const;
      } catch {
        return undefined;
      }
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}


export type WalletAggregateStatus = {
  network: "mainnet" | "testnet";
  accountAddress: `0x${string}`;
  hasDelegatedKeys: boolean;
  hasActiveKey: boolean;
  readiness: "needs_key" | "ready";
  activeKey?: RenderedWalletKey;
  issues: CapabilityIssue[];
  keyCount: number;
};

export async function getWalletAggregateStatus(
  options: StatusCommandOptions,
  dependencies: WalletCommandDependencies = {},
): Promise<WalletAggregateStatus> {
  const status = await getWalletStatus(options, dependencies);
  const capability = evaluateDelegatedKeyCapability({
    profile: { ...status, keys: status.keys },
    activeKey: status.activeKey,
  } as never);

  return {
    network: status.network,
    accountAddress: status.accountAddress,
    hasDelegatedKeys: status.keys.length > 0,
    hasActiveKey: status.activeKey !== undefined,
    readiness: capability.readiness,
    ...(status.activeKey === undefined ? {} : { activeKey: status.activeKey }),
    issues: capability.issues,
    keyCount: status.keys.length,
  };
}
