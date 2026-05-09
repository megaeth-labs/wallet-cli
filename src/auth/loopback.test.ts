import { mkdtemp, rm } from "node:fs/promises";
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
  buildCliAuthUrl,
  deriveDelegatedKeyPair,
  keccak256,
  runLoopbackLogin,
  type LoopbackRedirectUri,
} from "./loopback.js";
import {
  defaultLoginPermissions,
  encodePermissions,
  resolveLoginPermissions,
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
  it("constructs the wallet auth URL without local private key material", () => {
    const permissions = encodePermissions(
      defaultLoginPermissions(new Date("2026-05-07T00:00:00.000Z")),
    );
    const url = new URL(
      buildCliAuthUrl({
        walletUrl: "https://wallet.example/base",
        accessAddress: "0x1111111111111111111111111111111111111111",
        permissions,
        redirectUri: "http://127.0.0.1:49152/callback",
        state: testState,
        network: "testnet",
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
    expect(url.searchParams.get("network")).toBe("testnet");
    expect(url.searchParams.get("clientName")).toBe("mega-cli");
    expect(url.toString()).not.toContain(testPrivateKey);

    const decodedPermissions = JSON.parse(
      Buffer.from(url.searchParams.get("permissions")!, "base64url").toString(
        "utf8",
      ),
    ) as ReturnType<typeof defaultLoginPermissions>;
    expect(decodedPermissions.expiry).toBe(1_778_716_800);
    expect(decodedPermissions.feeToken).toEqual({
      limit: "0.01",
      symbol: "ETH",
    });
    expect(decodedPermissions.permissions).toEqual({
      calls: [],
      spend: [
        {
          limit: "100000000000000000000",
          period: "week",
          token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
        },
      ],
    });
  });

  it("derives Ethereum secp256k1 addresses using Keccak-256", () => {
    expect(keccak256(Buffer.alloc(0)).toString("hex")).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(deriveDelegatedKeyPair(testPrivateKey).accessAddress).toBe(
      "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    );
  });

  it("persists a profile only after approved state and access key validation", async () => {
    const env = await tempEnv();
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);
    let callbackUrl: URL | undefined;

    const result = await runLoopbackLogin({
      network: "testnet",
      privateKey: testPrivateKey,
      state: testState,
      permissionRequest: defaultLoginPermissions(
        new Date("2026-05-07T00:00:00.000Z"),
      ),
      walletUrl: "https://wallet.example",
      relayUrl: "https://relay.example",
      env,
      now: new Date("2026-05-07T00:00:00.000Z"),
      timeoutMs: 1_000,
      openBrowser: async (authUrl) => {
        const url = new URL(authUrl);
        expect(url.toString()).not.toContain(testPrivateKey);
        expect(url.searchParams.get("accessAddress")).toBe(
          keyPair.accessAddress,
        );
        callbackUrl = buildCallbackUrl(
          url.searchParams.get("redirectUri") as LoopbackRedirectUri,
          {
            state: url.searchParams.get("state")!,
            status: "approved",
            accountAddress: "0x1111111111111111111111111111111111111111",
            accessAddress: keyPair.accessAddress,
            authorizedKey: makeAuthorizedKey(keyPair.publicKey),
            grantTxHash: "0xabcdef",
          },
        );

        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);
      },
    });

    const stored = await readWalletProfile("testnet", env);
    expect(stored).toEqual(result.profile);
    expect(stored.privateKey).toBe(testPrivateKey);
    expect(stored.accessAddress).toBe(keyPair.accessAddress);
    expect(stored.authorizedKey.publicKey).toBe(keyPair.publicKey);
    await expect(profileExists("mainnet", env)).resolves.toBe(false);

    await expect(fetch(callbackUrl!)).rejects.toThrow();
  });

  it("defaults mainnet login to the canonical wallet UI and relay", async () => {
    const env = await tempEnv();
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);
    const chainConfig = getChainConfig("mainnet");

    const result = await runLoopbackLogin({
      network: "mainnet",
      privateKey: testPrivateKey,
      state: testState,
      permissionRequest: defaultLoginPermissions(
        new Date("2026-05-07T00:00:00.000Z"),
      ),
      env,
      now: new Date("2026-05-07T00:00:00.000Z"),
      timeoutMs: 1_000,
      openBrowser: async (authUrl) => {
        const url = new URL(authUrl);
        expect(url.origin).toBe(chainConfig.walletUrl);

        const response = await fetch(
          buildCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: url.searchParams.get("state")!,
              status: "approved",
              accountAddress: "0x1111111111111111111111111111111111111111",
              accessAddress: keyPair.accessAddress,
              authorizedKey: makeAuthorizedKey(keyPair.publicKey),
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
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);

    await expect(
      runLoopbackLogin({
        network: "testnet",
        privateKey: testPrivateKey,
        state: testState,
        permissionRequest: defaultLoginPermissions(),
        env,
        timeoutMs: 1_000,
        openBrowser: async (authUrl) => {
          const url = new URL(authUrl);
          const callbackUrl = buildCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: "wrong-state-12345678901234567890",
              status: "approved",
              accountAddress: "0x1111111111111111111111111111111111111111",
              accessAddress: keyPair.accessAddress,
              authorizedKey: makeAuthorizedKey(keyPair.publicKey),
            },
          );

          const response = await fetch(callbackUrl);
          expect(response.status).toBe(400);
        },
      }),
    ).rejects.toThrow("callback state mismatch");

    await expect(profileExists("testnet", env)).resolves.toBe(false);
  });

  it("rejects access address mismatch without writing a profile", async () => {
    const env = await tempEnv();
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);

    await expect(
      runLoopbackLogin({
        network: "testnet",
        privateKey: testPrivateKey,
        state: testState,
        permissionRequest: defaultLoginPermissions(),
        env,
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

    await expect(profileExists("testnet", env)).resolves.toBe(false);
  });

  it("maps cancellation to a clear login failure", async () => {
    const env = await tempEnv();

    await expect(
      runLoopbackLogin({
        network: "testnet",
        privateKey: testPrivateKey,
        state: testState,
        permissionRequest: defaultLoginPermissions(),
        env,
        timeoutMs: 1_000,
        openBrowser: async (authUrl) => {
          const url = new URL(authUrl);
          const callbackUrl = buildCallbackUrl(
            url.searchParams.get("redirectUri") as LoopbackRedirectUri,
            {
              state: testState,
              status: "cancelled",
            },
          );

          const response = await fetch(callbackUrl);
          expect(response.status).toBe(200);
        },
      }),
    ).rejects.toThrow("wallet authorization was cancelled");

    await expect(profileExists("testnet", env)).resolves.toBe(false);
  });

  it("times out clearly when no callback arrives", async () => {
    const env = await tempEnv();

    await expect(
      runLoopbackLogin({
        network: "testnet",
        privateKey: testPrivateKey,
        state: testState,
        permissionRequest: defaultLoginPermissions(),
        env,
        timeoutMs: 20,
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow("wallet login timed out after 20ms");

    await expect(profileExists("testnet", env)).resolves.toBe(false);
  });

  it("parses allow-call entries into the encoded permission request", async () => {
    const permissions = await resolveLoginPermissions({
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
