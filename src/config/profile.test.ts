import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { redactedValue, toJson } from "../output.js";
import {
  deleteWalletProfile,
  getProfileMode,
  listWalletProfiles,
  parseWalletProfile,
  profileExists,
  readWalletProfile,
  serializePermissions,
  summarizeProfile,
  type WalletProfile,
  writeWalletProfile,
} from "./profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet profile storage", () => {
  it("round-trips a profile through a temp config dir", async () => {
    const env = await tempEnv();
    const profile = makeProfile();

    await writeWalletProfile(profile, env);

    await expect(profileExists("mainnet", env)).resolves.toBe(true);
    await expect(readWalletProfile("mainnet", env)).resolves.toEqual(profile);
    await expect(listWalletProfiles(env)).resolves.toEqual([profile]);
  });

  it("writes profile files with 0600 mode", async () => {
    const env = await tempEnv();

    await writeWalletProfile(makeProfile(), env);

    expect(await getProfileMode("mainnet", env)).toBe(0o600);
  });

  it("serializes approved permissions without deriving them from private key material", () => {
    const profile = makeProfile();

    expect(
      serializePermissions(profile.keys[0]!.authorizedKey.permissions),
    ).toBe(JSON.stringify(profile.keys[0]!.authorizedKey.permissions));
  });

  it("accepts arbitrary and partial call permission scopes", () => {
    const arbitrary = parseWalletProfile({
      ...makeProfile(),
      keys: [
        {
          ...makeProfile().keys[0]!,
          authorizedKey: {
            ...makeProfile().keys[0]!.authorizedKey,
            permissions: {
              spend: makeProfile().keys[0]!.authorizedKey.permissions.spend,
            },
          },
        },
      ],
    });
    expect(arbitrary.keys[0]!.authorizedKey.permissions.calls).toBeUndefined();

    const partial = parseWalletProfile({
      ...makeProfile(),
      keys: [
        {
          ...makeProfile().keys[0]!,
          authorizedKey: {
            ...makeProfile().keys[0]!.authorizedKey,
            permissions: {
              calls: [
                {
                  to: "0x4444444444444444444444444444444444444444",
                },
                {
                  signature: "transfer(address,uint256)",
                },
              ],
              spend: makeProfile().keys[0]!.authorizedKey.permissions.spend,
            },
          },
        },
      ],
    });
    expect(partial.keys[0]!.authorizedKey.permissions.calls).toEqual([
      {
        to: "0x4444444444444444444444444444444444444444",
      },
      {
        signature: "transfer(address,uint256)",
      },
    ]);

    const explicitArbitrary = parseWalletProfile({
      ...makeProfile(),
      keys: [
        {
          ...makeProfile().keys[0]!,
          authorizedKey: {
            ...makeProfile().keys[0]!.authorizedKey,
            permissions: {
              calls: [{}],
              spend: makeProfile().keys[0]!.authorizedKey.permissions.spend,
            },
          },
        },
      ],
    });
    expect(explicitArbitrary.keys[0]!.authorizedKey.permissions.calls).toEqual([
      {},
    ]);
  });

  it("accepts optional wallet API URLs without requiring old profiles to rewrite", () => {
    expect(parseWalletProfile(makeProfile()).walletApiUrl).toBeUndefined();

    expect(
      parseWalletProfile({
        ...makeProfile(),
        walletApiUrl: "https://wallet-api.example",
      }).walletApiUrl,
    ).toBe("https://wallet-api.example");
  });

  it("redacts private keys from summaries and json output", () => {
    const profile = makeProfile();

    expect(JSON.stringify(summarizeProfile(profile))).not.toContain(
      profile.keys[0]!.privateKey,
    );

    const rendered = toJson(profile);
    expect(rendered).not.toContain(profile.keys[0]!.privateKey);
    expect(rendered).toContain(`"privateKey": "${redactedValue}"`);
    expect(rendered).toContain(
      profile.keys[0]!.authorizedKey.permissions.spend[0]!.token,
    );
  });

  it("rejects invalid profile shapes", () => {
    expect(() =>
      parseWalletProfile({
        ...makeProfile(),
        keys: [{ ...makeProfile().keys[0]!, privateKey: "0x1234" }],
      }),
    ).toThrow("privateKey must be a 32-byte hex string");
    expect(() =>
      parseWalletProfile({
        ...makeProfile(),
        keys: [
          {
            ...makeProfile().keys[0]!,
            authorizedKey: {
              ...makeProfile().keys[0]!.authorizedKey,
              permissions: {
                calls: [],
                spend: [{ limit: "1", period: "century" }],
              },
            },
          },
        ],
      }),
    ).toThrow("unsupported spend permission period");
  });

  it("deletes profiles idempotently", async () => {
    const env = await tempEnv();

    await writeWalletProfile(makeProfile(), env);

    await expect(deleteWalletProfile("mainnet", env)).resolves.toBe(true);
    await expect(deleteWalletProfile("mainnet", env)).resolves.toBe(false);
    await expect(readWalletProfile("mainnet", env)).rejects.toThrow(
      "run mega wallet login",
    );
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-cli-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function makeProfile(): WalletProfile {
  return {
    version: 1,
    network: "mainnet",
    accountAddress: "0x1111111111111111111111111111111111111111",
    activeKeyId: "0x2222222222222222222222222222222222222222",
    keys: [
      {
        id: "0x2222222222222222222222222222222222222222",
        accessAddress: "0x2222222222222222222222222222222222222222",
        privateKey:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        authorizedKey: {
          type: "secp256k1",
          role: "session",
          publicKey: "0x3333333333333333333333333333333333333333",
          expiry: 1_800_000_000,
          feeToken: {
            limit: "1000000000000000",
            symbol: "ETH",
          },
          permissions: {
            calls: [
              {
                to: "0x4444444444444444444444444444444444444444",
                signature: "transfer(address,uint256)",
              },
            ],
            spend: [
              {
                limit: "100000000000000000",
                period: "day",
                token: "0x5555555555555555555555555555555555555555",
              },
            ],
          },
        },
        grantTxHash: "0x666666",
        status: "active",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    ],
    walletUrl: "https://wallet.example",
    relayUrl: "https://relay.example",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
  };
}
