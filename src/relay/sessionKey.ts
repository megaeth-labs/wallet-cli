import { Key } from "porto";

import type {
  AuthorizedKey,
  HexString,
  WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";

export type RelaySessionKey = Key.Secp256k1Key;

type PortoFeeLimit = `${number}` | `${number}.${number}`;
type PortoPermissions = NonNullable<RelaySessionKey["permissions"]>;

export function sessionKeyFromProfile(profile: WalletProfile): RelaySessionKey {
  const key = Key.fromSecp256k1({
    expiry: profile.authorizedKey.expiry,
    feeToken: toPortoFeeToken(profile.authorizedKey.feeToken),
    permissions: toPortoPermissions(profile.authorizedKey.permissions),
    privateKey: profile.privateKey,
    role: "session",
  });

  if (key.publicKey.toLowerCase() !== profile.accessAddress.toLowerCase()) {
    throw new CliError(
      "wallet profile delegated private key does not match access address",
    );
  }

  if (
    profile.authorizedKey.publicKey.length === profile.accessAddress.length &&
    key.publicKey.toLowerCase() !==
      profile.authorizedKey.publicKey.toLowerCase()
  ) {
    throw new CliError(
      "wallet profile authorized key does not match delegated key",
    );
  }

  return key;
}

function toPortoFeeToken(
  feeToken: AuthorizedKey["feeToken"],
): RelaySessionKey["feeToken"] {
  if (feeToken === undefined) {
    return undefined;
  }

  return {
    limit: parsePortoFeeLimit(feeToken.limit),
    symbol: feeToken.symbol,
  };
}

function toPortoPermissions(
  permissions: AuthorizedKey["permissions"],
): PortoPermissions {
  return {
    calls: permissions.calls.map((call) => ({
      signature: call.signature,
      to: call.to,
    })),
    spend: permissions.spend.map((spend) => {
      const parsed = parseSpendLimit(spend.limit);
      return spend.token === undefined
        ? {
            limit: parsed,
            period: spend.period,
          }
        : {
            limit: parsed,
            period: spend.period,
            token: spend.token,
          };
    }),
  };
}

function parsePortoFeeLimit(value: string): PortoFeeLimit {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new CliError(
      "wallet profile authorizedKey.feeToken.limit must be numeric",
    );
  }

  return value as PortoFeeLimit;
}

function parseSpendLimit(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new CliError("wallet profile spend permission limit must be numeric");
  }

  return BigInt(value);
}
