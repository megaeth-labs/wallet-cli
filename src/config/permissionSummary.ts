import type { AuthorizedKey, HexString } from "./profile.js";

export type TokenDisplayMetadata = {
  decimals: number;
  symbol?: string;
};

export type TokenDisplayMetadataMap = Record<string, TokenDisplayMetadata>;

export type PermissionSummary = {
  expiresAt: string;
  lines: string[];
};

const builtinTokenMetadata: TokenDisplayMetadataMap = {
  "0xfafddbb3fc7688494971a79cc65dca3ef82079e7": {
    decimals: 18,
    symbol: "USDm",
  },
  "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": {
    decimals: 6,
    symbol: "USDT0",
  },
};

const nativeTokenAddress = "0x0000000000000000000000000000000000000000";

export function summarizeAuthorizedKey(
  authorizedKey: AuthorizedKey,
  tokenMetadata: TokenDisplayMetadataMap = {},
): PermissionSummary {
  return {
    expiresAt: new Date(authorizedKey.expiry * 1000).toISOString(),
    lines: [
      ...summarizeSpend(
        authorizedKey.permissions.spend,
        authorizedKey.expiry,
        tokenMetadata,
      ),
      ...summarizeCalls(authorizedKey.permissions.calls, tokenMetadata),
      ...summarizeFeeToken(authorizedKey.feeToken),
    ],
  };
}

function summarizeSpend(
  spendPermissions: AuthorizedKey["permissions"]["spend"],
  expiry: number,
  tokenMetadata: TokenDisplayMetadataMap,
): string[] {
  if (spendPermissions.length === 0) {
    return ["No token spend permission"];
  }

  return spendPermissions.map((spend) => {
    const token = tokenLabel(spend.token, tokenMetadata);
    const amount = formatTokenAmount(spend.limit, spend.token, tokenMetadata);

    if (spend.period === "year" && expiresWithinOneYear(expiry)) {
      return `Can spend up to ${amount} ${token} until key expiry`;
    }

    return `Can spend up to ${amount} ${token} per ${spend.period}`;
  });
}

function summarizeCalls(
  callPermissions: AuthorizedKey["permissions"]["calls"],
  tokenMetadata: TokenDisplayMetadataMap,
): string[] {
  if (callPermissions === undefined) {
    return ["No explicit contract call permission"];
  }

  if (callPermissions.length === 0) {
    return ["No contract call permission"];
  }

  return callPermissions.map((call) => {
    if (!call.signature && !call.to) {
      return "Can call any contract/function";
    }
    if (call.signature && call.to) {
      return `Can call ${call.signature} on ${tokenLabel(call.to, tokenMetadata)}`;
    }
    if (call.signature) {
      return `Can call ${call.signature} on any contract`;
    }
    return `Can call any function on ${tokenLabel(call.to, tokenMetadata)}`;
  });
}

function summarizeFeeToken(feeToken: AuthorizedKey["feeToken"]): string[] {
  if (feeToken === undefined) {
    return ["No relay fee token permission"];
  }

  return [
    `Can pay up to ${feeToken.limit} ${displayTokenSymbol(feeToken.symbol)} in relay fees`,
  ];
}

export function tokenLabel(
  token: HexString | undefined,
  tokenMetadata: TokenDisplayMetadataMap = {},
): string {
  if (token === undefined || isNativeTokenAddress(token)) {
    return "ETH";
  }

  const metadata = resolveTokenMetadata(token, tokenMetadata);
  return metadata?.symbol === undefined
    ? `${token.slice(0, 6)}...${token.slice(-4)}`
    : displayTokenSymbol(metadata.symbol);
}

export function formatTokenAmount(
  limit: string,
  token: HexString | undefined,
  tokenMetadata: TokenDisplayMetadataMap = {},
): string {
  const decimals =
    token === undefined || isNativeTokenAddress(token)
      ? 18
      : tokenDecimals(token, tokenMetadata);

  if (!/^\d+$/.test(limit)) {
    return limit;
  }

  const value = BigInt(limit);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;

  if (fraction === 0n) {
    return whole.toString();
  }

  const padded = fraction.toString().padStart(decimals, "0");
  const trimmed = padded.replace(/0+$/u, "");

  return `${whole.toString()}.${trimmed}`;
}

function tokenDecimals(
  token: HexString,
  tokenMetadata: TokenDisplayMetadataMap,
): number {
  return resolveTokenMetadata(token, tokenMetadata)?.decimals ?? 18;
}

function resolveTokenMetadata(
  token: HexString,
  tokenMetadata: TokenDisplayMetadataMap,
): TokenDisplayMetadata | undefined {
  const normalized = token.toLowerCase();
  return tokenMetadata[normalized] ?? builtinTokenMetadata[normalized];
}

function isNativeTokenAddress(token: HexString): boolean {
  return token.toLowerCase() === nativeTokenAddress;
}

function displayTokenSymbol(symbol: string | undefined): string {
  if (symbol === undefined) {
    return "token";
  }

  if (symbol.toLowerCase() === "usdm") {
    return "USDm";
  }

  return symbol;
}

function expiresWithinOneYear(expiry: number): boolean {
  const now = Date.now() / 1000;
  return expiry - now <= 366 * 24 * 60 * 60;
}
