import { privateKeyToAccount } from "viem/accounts";

import type {
  AuthorizedKey,
  HexString,
  WalletProfile,
} from "../config/profile.js";
import { CliError } from "../errors.js";

export type RelaySessionKey = {
  expiry: number;
  permissions: AuthorizedKey["permissions"];
  prehash: false;
  privateKey: HexString;
  publicKey: HexString;
  role: "session";
  type: "secp256k1";
};

export type RelayKeyReference = {
  prehash: false;
  publicKey: HexString;
  type: "secp256k1";
};

export function sessionKeyFromProfile(profile: WalletProfile): RelaySessionKey {
  const account = privateKeyToAccount(profile.privateKey);

  if (account.address.toLowerCase() !== profile.accessAddress.toLowerCase()) {
    throw new CliError(
      "wallet profile delegated private key does not match access address",
    );
  }

  return {
    expiry: profile.authorizedKey.expiry,
    permissions: profile.authorizedKey.permissions,
    prehash: false,
    privateKey: profile.privateKey,
    publicKey: profile.authorizedKey.publicKey,
    role: "session",
    type: "secp256k1",
  };
}

export function relayKeyReference(key: RelaySessionKey): RelayKeyReference {
  return {
    prehash: key.prehash,
    publicKey: key.publicKey,
    type: key.type,
  };
}

export async function signRelayDigest(
  key: RelaySessionKey,
  digest: HexString,
): Promise<HexString> {
  const account = privateKeyToAccount(key.privateKey);
  return account.sign({ hash: digest });
}
