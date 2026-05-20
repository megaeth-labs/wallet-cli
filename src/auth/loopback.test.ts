import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  profileExists,
  readWalletProfile,
  type AuthorizedKey,
} from "../config/profile.js";
import { getChainConfig } from "../config/chains.js";
import {
  authorizeLoopbackKey,
  buildCliAuthUrl,
  buildCliLoginUrl,
  deriveDelegatedKeyPair,
  keccak256,
  runLoopbackLogin,
  type LoopbackRedirectUri,
} from "./loopback.js";
import {
  defaultKeyPermissions,
  encodePermissions,
  resolveKeyPermissions,
} from "./permissions.js";

const tempDirs: string[] = [];
const testPrivateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const testState = "state-12345678901234567890123456789012";

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("loopback login", () => {
  it("constructs the wallet key auth URL without local private key material", () => {
    const request = defaultKeyPermissions(
      new Date("2026-05-07T00:00:00.000Z"),
    );
    const permissions = encodePermissions({
      ...request,
      permissions: {
        ...request.permissions,
        calls: [
          {
            to: "0x3333333333333333333333333333333333333333",
            signature: "transfer(address,uint256)",
          },
        ],
      },
    });
    const url = new URL(
      buildCliAuthUrl({
        walletUrl: "https://wallet.example/base",
        accessAddress: "0x1111111111111111111111111111111111111111",
        permissions,
        redirectUri: "http://127.0.0.1:49152/callback",
        state: testState,
        network: "mainnet",
        clientName: "mega-cli",
      }),
    );

    expect(url.origin).toBe("https://wallet.example");
    expect(url.pathname).toBe("/cli-auth/loopback");
    expect(url.searchParams.get("accessAddress")).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(url.searchParams.get("redirectUri")).toBe(
      "http://127.0.0.1:49152/callback",
    );
    expect(url.searchParams.get("state")).toBe(testState);
    expect(url.searchParams.get("network")).toBe("mainnet");
    expect(url.searchParams.get("clientName")).toBe("mega-cli");
    expect(url.toString()).not.toContain(testPrivateKey);

    const decodedPermissions = JSON.parse(
      Buffer.from(url.searchParams.get("permissions")!, "base64url").toString(
        "utf8",
      ),
    ) as ReturnType<typeof defaultKeyPermissions>;
    expect(decodedPermissions.expiry).toBe(1_778_716_800);
    expect(decodedPermissions.feeToken).toEqual({
      limit: "1",
      symbol: "USDM",
    });
    expect(decodedPermissions.permissions).toEqual({
      calls: [
        {
          to: "0x3333333333333333333333333333333333333333",
          signature: "transfer(address,uint256)",
        },
      ],
      spend: [
        {
          limit: "100000000000000000000",
          period: "week",
          token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        },
      ],
    });
  });

  it("constructs the account login URL without delegated key parameters", () => {
    const url = new URL(
      buildCliLoginUrl({
        walletUrl: "https://wallet.example/base",
        redirectUri: "http://127.0.0.1:49152/callback",
        state: testState,
        network: "mainnet",
        clientName: "mega-cli",
      }),
    );

    expect(url.origin).toBe("https://wallet.example");
    expect(url.pathname).toBe("/cli-auth/loopback");
    expect(url.searchParams.get("operation")).toBe("login");
    expect(url.searchParams.get("redirectUri")).toBe(
      "http://127.0.0.1:49152/callback",
    );
    expect(url.searchParams.get("state")).toBe(testState);
    expect(url.searchParams.get("network")).toBe("mainnet");
    expect(url.searchParams.get("clientName")).toBe("mega-cli");
    expect(url.searchParams.has("accessAddress")).toBe(false);
    expect(url.searchParams.has("permissions")).toBe(false);
    expect(url.toString()).not.toContain(testPrivateKey);
  });

  it("derives Ethereum secp256k1 addresses using Keccak-256", () => {
    expect(keccak256(Buffer.alloc(0)).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(deriveDelegatedKeyPair(testPrivateKey).accessAddress).toBe(
      "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    );
  });

  it("persists an account profile only after approved state validation", async () => {
    const env = await tempEnv();
    let callbackUrl: URL | undefined;

    const result = await runLoopbackLogin({
      network: "mainnet",
      state: testState,
      walletUrl: "https://wallet.example",
      relayUrl: "https://relay.example",
      env,
      now: new Date("2026-05-07T00:00:00.000Z"),
      timeoutMs: 1_000,
      openBrowser: async (authUrl) => {
        const url = new URL(authUrl);
        expect(url.toString()).not.toContain(testPrivateKey);
        expect(url.searchParams.has("accessAddress")).toBe(false);
        expect(url.searchParams.has("permissions")).toBe(false);
        callbackUrl = buildLoginCallbackUrl(
          url.searchParams.get("redirectUri") as LoopbackRedirectUri,
          {
            state: url.searchParams.get("state")!,
            status: "approved",
            accountAddress: "0x1111111111111111111111111111111111111111",
          },
        );

        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toContain(
          "Wallet login successful. You can close this browser window.",
        );
      },
    });

    const stored = await readWalletProfile("mainnet", env);
    expect(stored).toEqual(result.profile);
    expect(stored.activeKeyId).toBeUndefined();
    expect(stored.keys).toEqual([]);
    await expect(fetch(callbackUrl!)).rejects.toThrow();
  });

  it("defaults mainnet login to the production wallet UI and canonical relay", async () => {
    const env = await tempEnv();
    const chainConfig = getChainConfig("mainnet");

    const result = await runLoopbackLogin({
      network: "mainnet",
      state: testState,
      env,
      now: new Date("2026-05-07T00:00:00.000Z"),
      timeoutMs: 1_000,
      openBrowser: async (authUrl) => {
        const url = new URL(authUrl);
        expect(url.origin).toBe(chainConfig.walletUrl);

        const response = await fetch(
          buildLoginCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: url.searchParams.get("state")!,
              status: "approved",
              accountAddress: "0x1111111111111111111111111111111111111111",
            },
          ),
        );
        expect(response.status).toBe(200);
      },
    });

    expect(result.profile.walletUrl).toBe(chainConfig.walletUrl);
    expect(result.profile.relayUrl).toBe(chainConfig.relayUrl);
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      walletUrl: "https://account.megaeth.com",
      relayUrl: "https://wallet-relay.megaeth.com",
    });
  });

  it("rejects state mismatch without writing a profile", async () => {
    const env = await tempEnv();

    await expect(
      runLoopbackLogin({
        network: "mainnet",
        state: testState,
        env,
        timeoutMs: 1_000,
        openBrowser: async (authUrl) => {
          const url = new URL(authUrl);
          const callbackUrl = buildLoginCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: "wrong-state-12345678901234567890",
              status: "approved",
              accountAddress: "0x1111111111111111111111111111111111111111",
            },
          );

          const response = await fetch(callbackUrl);
          expect(response.status).toBe(400);
        },
      }),
    ).rejects.toThrow("callback state mismatch");

    await expect(profileExists("mainnet", env)).resolves.toBe(false);
  });

  it("rejects key authorization access address mismatch", async () => {
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);

    await expect(
      authorizeLoopbackKey({
        network: "mainnet",
        privateKey: testPrivateKey,
        state: testState,
        permissionRequest: {
          ...defaultKeyPermissions(),
          permissions: {
            ...defaultKeyPermissions().permissions,
            calls: [
              {
                to: "0x3333333333333333333333333333333333333333",
                signature: "transfer(address,uint256)",
              },
            ],
          },
        },
        timeoutMs: 1_000,
        openBrowser: async (authUrl) => {
          const url = new URL(authUrl);
          const callbackUrl = buildCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: testState,
              status: "approved",
              accountAddress: "0x1111111111111111111111111111111111111111",
              accessAddress: "0x2222222222222222222222222222222222222222",
              authorizedKey: makeAuthorizedKey(keyPair.publicKey),
            },
          );

          const response = await fetch(callbackUrl);
          expect(response.status).toBe(400);
        },
      }),
    ).rejects.toThrow("callback access address mismatch");
  });

  it("maps cancellation to a clear login failure", async () => {
    const env = await tempEnv();

    await expect(
      runLoopbackLogin({
        network: "mainnet",
        state: testState,
        env,
        timeoutMs: 1_000,
        openBrowser: async (authUrl) => {
          const url = new URL(authUrl);
          const callbackUrl = buildLoginCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: testState,
              status: "cancelled",
            },
          );

          const response = await fetch(callbackUrl);
          expect(response.status).toBe(200);
          await expect(response.text()).resolves.toContain(
            "Wallet login cancelled. You can close this browser window.",
          );
        },
      }),
    ).rejects.toThrow("wallet login was cancelled");

    await expect(profileExists("mainnet", env)).resolves.toBe(false);
  });

  it("times out clearly when no callback arrives", async () => {
    const env = await tempEnv();

    await expect(
      runLoopbackLogin({
        network: "mainnet",
        state: testState,
        env,
        timeoutMs: 20,
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow("wallet login timed out after 20ms");

    await expect(profileExists("mainnet", env)).resolves.toBe(false);
  });

  it("parses allow-call entries into the encoded permission request", async () => {
    const permissions = await resolveKeyPermissions({
      now: new Date("2026-05-07T00:00:00.000Z"),
      allowCalls: [
        "0x3333333333333333333333333333333333333333:transfer(address,uint256)",
      ],
    });

    expect(permissions.permissions.calls).toEqual([
      {
        to: "0x3333333333333333333333333333333333333333",
        signature: "transfer(address,uint256)",
      },
    ]);
    expect(
      JSON.parse(
        Buffer.from(encodePermissions(permissions), "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual(permissions);
  });

  it("applies a create-key spend limit to the default USDM spend request", async () => {
    const permissions = await resolveKeyPermissions({
      now: new Date("2026-05-07T00:00:00.000Z"),
      spendLimit: "12.5",
      allowCalls: [
        "0x3333333333333333333333333333333333333333:transfer(address,uint256)",
      ],
    });

    expect(permissions.permissions.spend).toEqual([
      {
        limit: "12500000000000000000",
        period: "week",
        token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
      },
    ]);
    expect(permissions.permissions.calls).toEqual([
      {
        to: "0x3333333333333333333333333333333333333333",
        signature: "transfer(address,uint256)",
      },
    ]);
  });

  it("rejects default create-key permissions without an explicit call scope", async () => {
    await expect(
      resolveKeyPermissions({
        now: new Date("2026-05-07T00:00:00.000Z"),
        spendLimit: "12.5",
      }),
    ).rejects.toThrow("Use create-key --allow-call");
  });

  it("rejects custom permission files with empty call permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mega-wallet-cli-permissions-"));
    tempDirs.push(dir);
    const permissionsFile = join(dir, "permissions.json");
    await writeFile(
      permissionsFile,
      JSON.stringify({
        expiry: 1_800_000_000,
        feeToken: {
          limit: "1",
          symbol: "USDM",
        },
        permissions: {
          calls: [],
          spend: [
            {
              limit: "1000000000000000",
              period: "week",
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(resolveKeyPermissions({ permissionsFile })).rejects.toThrow(
      "permissions.calls must be present and include at least one call",
    );
  });

  it("rejects custom permission files with omitted call permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mega-wallet-cli-permissions-"));
    tempDirs.push(dir);
    const permissionsFile = join(dir, "permissions.json");
    await writeFile(
      permissionsFile,
      JSON.stringify({
        expiry: 1_800_000_000,
        feeToken: {
          limit: "1",
          symbol: "USDM",
        },
        permissions: {
          spend: [
            {
              limit: "1000000000000000",
              period: "week",
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(resolveKeyPermissions({ permissionsFile })).rejects.toThrow(
      "permissions.calls must be present and be an array",
    );
  });

  it("uses the testnet USDM token for testnet default permissions", async () => {
    const permissions = await resolveKeyPermissions({
      network: "testnet",
      now: new Date("2026-05-07T00:00:00.000Z"),
      spendLimit: "12.5",
      allowCalls: [
        "0x3333333333333333333333333333333333333333:transfer(address,uint256)",
      ],
    });

    expect(permissions.permissions.spend).toEqual([
      {
        limit: "12500000000000000000",
        period: "week",
        token: "0x15e9f2b0a747ac05c7446559306687085d161e5c",
      },
    ]);
    expect(permissions.permissions.calls).toEqual([
      {
        to: "0x3333333333333333333333333333333333333333",
        signature: "transfer(address,uint256)",
      },
    ]);
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-cli-loopback-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function buildCallbackUrl(
  redirectUri: LoopbackRedirectUri,
  result:
    | {
        state: string;
        status: "approved";
        accountAddress: `0x${string}`;
        accessAddress: `0x${string}`;
        authorizedKey: AuthorizedKey;
        grantTxHash?: `0x${string}`;
      }
    | {
        state: string;
        status: "cancelled" | "error";
        error?: string;
      },
): URL {
  const url = new URL(redirectUri);
  url.searchParams.set("state", result.state);
  url.searchParams.set("status", result.status);

  if (result.status === "approved") {
    url.searchParams.set("accountAddress", result.accountAddress);
    url.searchParams.set("accessAddress", result.accessAddress);
    url.searchParams.set(
      "authorizedKey",
      Buffer.from(JSON.stringify(result.authorizedKey), "utf8").toString(
        "base64url",
      ),
    );
    if (result.grantTxHash) {
      url.searchParams.set("grantTxHash", result.grantTxHash);
    }
  } else if (result.error) {
    url.searchParams.set("error", result.error);
  }

  return url;
}

function buildLoginCallbackUrl(
  redirectUri: LoopbackRedirectUri,
  result:
    | {
        state: string;
        status: "approved";
        accountAddress: `0x${string}`;
      }
    | {
        state: string;
        status: "cancelled" | "error";
        error?: string;
      },
): URL {
  const url = new URL(redirectUri);
  url.searchParams.set("state", result.state);
  url.searchParams.set("status", result.status);

  if (result.status === "approved") {
    url.searchParams.set("accountAddress", result.accountAddress);
  } else if (result.error) {
    url.searchParams.set("error", result.error);
  }

  return url;
}

function makeAuthorizedKey(publicKey: `0x${string}`): AuthorizedKey {
  return {
    type: "secp256k1",
    role: "session",
    publicKey,
    expiry: 1_800_000_000,
    feeToken: {
      limit: "1000000000000000",
      symbol: "ETH",
    },
    permissions: {
      calls: [
        {
          to: "0x3333333333333333333333333333333333333333",
          signature: "transfer(address,uint256)",
        },
      ],
      spend: [
        {
          limit: "100000000000000000",
          period: "day",
        },
      ],
    },
  };
}
