import type { AuthorizedKey, HexString } from "./profile.js";

export type PermissionSummary = {
  expiresAt: string;
  lines: string[];
};

const tokenMetadata: Record<string, { decimals: number; symbol: string }> = {
  "0xfafddbb3fc7688494971a79cc65dca3ef82079e7": {
    decimals: 18,
    symbol: "USDm",
  },
};

export function summarizeAuthorizedKey(
  authorizedKey: AuthorizedKey,
): PermissionSummary {
  return {
    expiresAt: new Date(authorizedKey.expiry * 1000).toISOString(),
    lines: [
      ...summarizeSpend(authorizedKey.permissions.spend, authorizedKey.expiry),
      ...summarizeCalls(authorizedKey.permissions.calls),
      ...summarizeFeeToken(authorizedKey.feeToken),
    ],
  };
}

function summarizeSpend(
  spendPermissions: AuthorizedKey["permissions"]["spend"],
  expiry: number,
): string[] {
  if (spendPermissions.length === 0) {
    return ["No token spend permission"];
  }

  return spendPermissions.map((spend) => {
    const token = tokenLabel(spend.token);
    const amount = formatTokenAmount(spend.limit, spend.token);

    if (spend.period === "year" && expiresWithinOneYear(expiry)) {
      return `Can spend up to ${amount} ${token} until key expiry`;
    }

    return `Can spend up to ${amount} ${token} per ${spend.period}`;
  });
}

function summarizeCalls(
  callPermissions: AuthorizedKey["permissions"]["calls"],
): string[] {
  if (callPermissions === undefined) {
    return ["Can call any contract/function"];
  }

  if (callPermissions.length === 0) {
    return ["No contract call permission"];
  }

  return callPermissions.map((call) => {
    if (!call.signature && !call.to) {
      return "Can call any contract/function";
    }
    if (call.signature && call.to) {
      return `Can call ${call.signature} on ${tokenLabel(call.to)}`;
    }
    if (call.signature) {
      return `Can call ${call.signature} on any contract`;
    }
    return `Can call any function on ${tokenLabel(call.to)}`;
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

function tokenLabel(token: HexString | undefined): string {
  if (token === undefined) {
    return "ETH";
  }

  return (
    tokenMetadata[token.toLowerCase()]?.symbol ??
    `${token.slice(0, 6)}...${token.slice(-4)}`
  );
}

function formatTokenAmount(
  limit: string,
  token: HexString | undefined,
): string {
  const decimals =
    token === undefined
      ? 18
      : (tokenMetadata[token.toLowerCase()]?.decimals ?? 18);

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
