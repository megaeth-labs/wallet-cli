import { Key } from "porto";

import type {
  AuthorizedKey,
  HexString,
  WalletKeyRecord,
  WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";

export type RelaySessionKey = Key.Secp256k1Key;

type PortoFeeLimit = `${number}` | `${number}.${number}`;
type PortoPermissions = NonNullable<RelaySessionKey["permissions"]>;

export function sessionKeyFromProfile(profile: WalletProfile): RelaySessionKey {
  const activeKey =
    profile.activeKeyId === undefined
      ? profile.keys.find((keyRecord) => keyRecord.status === "active")
      : profile.keys.find(
          (keyRecord) =>
            keyRecord.id.toLowerCase() === profile.activeKeyId?.toLowerCase(),
        );

  if (activeKey === undefined) {
    throw new CliError("wallet profile has no active delegated key");
  }

  return sessionKeyFromWalletKey(activeKey);
}

export function sessionKeyFromWalletKey(
  walletKey: WalletKeyRecord,
): RelaySessionKey {
  if (walletKey.privateKey === undefined) {
    throw new CliError("delegated key private material is not available");
  }

  const key = Key.fromSecp256k1({
    expiry: walletKey.authorizedKey.expiry,
    feeToken: toPortoFeeToken(walletKey.authorizedKey.feeToken),
    permissions: toPortoPermissions(walletKey.authorizedKey.permissions),
    privateKey: walletKey.privateKey,
    role: "session",
  });

  if (key.publicKey.toLowerCase() !== walletKey.accessAddress.toLowerCase()) {
    throw new CliError(
      "wallet profile delegated private key does not match access address",
    );
  }

  if (
    walletKey.authorizedKey.publicKey.length ===
      walletKey.accessAddress.length &&
    key.publicKey.toLowerCase() !==
      walletKey.authorizedKey.publicKey.toLowerCase()
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
  const portoPermissions: PortoPermissions = {
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

  if (permissions.calls !== undefined) {
    portoPermissions.calls = permissions.calls.map((call) => ({
      ...(call.signature === undefined ? {} : { signature: call.signature }),
      ...(call.to === undefined ? {} : { to: call.to }),
    })) as NonNullable<PortoPermissions["calls"]>;
  }

  return portoPermissions;
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
