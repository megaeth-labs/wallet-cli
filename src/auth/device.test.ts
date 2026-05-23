import { describe, expect, it } from "vitest";

import type { AuthorizedKey, HexString } from "../config/profile.js";
import type { CliPermissionRequest } from "./permissions.js";
import {
  HttpDeviceAuthClient,
  authorizeDeviceLogin,
  authorizeDeviceKey,
  authorizeDeviceRevoke,
  buildAuthorizationPrompt,
  parseDeviceTokenResponse,
  pollDeviceApproval,
  type DeviceAuthClient,
  type DeviceStartRequest,
  type DeviceStartResponse,
  type DeviceTokenRequest,
  type DeviceTokenResponse,
} from "./device.js";
import { deriveDelegatedKeyPair } from "./loopback.js";
import {
  createCodeChallenge,
  createPkcePair,
  createUserCode,
  formatUserCode,
  normalizeUserCode,
} from "./pkce.js";

const testPrivateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const testState = "state-12345678901234567890123456789012";
const testPermissions: CliPermissionRequest = {
  expiry: 1_800_000_000,
  feeToken: {
    limit: "1",
    symbol: "USDM",
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
        limit: "100000000000000000000",
        period: "week",
        token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
      },
    ],
  },
};

describe("PKCE helpers", () => {
  it("generates RFC 7636 S256 challenges", () => {
    expect(
      createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");

    const pair = createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pair.codeChallenge).toBe(createCodeChallenge(pair.codeVerifier));
    expect(pair.codeChallengeMethod).toBe("S256");
  });

  it("formats and normalizes human user codes", () => {
    expect(formatUserCode("abcd1234")).toBe("ABCD-1234");
    expect(normalizeUserCode(" abcd  - 1234 ")).toBe("ABCD-1234");
    expect(createUserCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(() => normalizeUserCode("short")).toThrow(
      "userCode must use the XXXX-XXXX format",
    );
  });
});

describe("device auth helpers", () => {
  it("parses token statuses and approved grant metadata", () => {
    expect(
      parseDeviceTokenResponse({ status: "authorization_pending" }),
    ).toEqual({
      status: "authorization_pending",
    });
    expect(
      parseDeviceTokenResponse({
        status: "authorization_pending",
        interval: 7,
      }),
    ).toEqual({ status: "authorization_pending", interval: 7 });
    expect(
      parseDeviceTokenResponse({ status: "slow_down", interval: 9 }),
    ).toEqual({
      status: "slow_down",
      interval: 9,
    });
    expect(parseDeviceTokenResponse({ status: "expired_token" })).toEqual({
      status: "expired_token",
    });
    expect(
      parseDeviceTokenResponse({ status: "access_denied", error: "cancelled" }),
    ).toEqual({ status: "access_denied", error: "cancelled" });

    expect(
      parseDeviceTokenResponse({
        status: "approved",
        operation: "login",
        state: testState,
        accountAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).toEqual({
      status: "approved",
      operation: "login",
      state: testState,
      accountAddress: "0x1111111111111111111111111111111111111111",
    });

    expect(
      parseDeviceTokenResponse({
        status: "approved",
        operation: "grant",
        state: testState,
        accountAddress: "0x1111111111111111111111111111111111111111",
        accessAddress: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
        authorizedKey: makeAuthorizedKey(
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        ),
        grantTxHash: "0xabcdef",
      }),
    ).toMatchObject({
      status: "approved",
      operation: "grant",
      state: testState,
      grantTxHash: "0xabcdef",
    });
  });

  it("maps pending and slow_down polling before returning approval", async () => {
    const calls: DeviceTokenRequest[] = [];
    const sleeps: number[] = [];
    const client = makeClient({
      token: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          return { status: "authorization_pending", interval: 2 };
        }
        if (calls.length === 2) {
          return { status: "slow_down", interval: 4 };
        }
        return makeGrantApproval();
      },
    });

    const result = await pollDeviceApproval(client, {
      deviceCode: "device-secret",
      codeVerifier: "verifier-secret",
      intervalSeconds: 1,
      timeoutMs: 30_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(result.status).toBe("approved");
    expect(calls).toEqual([
      { deviceCode: "device-secret", codeVerifier: "verifier-secret" },
      { deviceCode: "device-secret", codeVerifier: "verifier-secret" },
      { deviceCode: "device-secret", codeVerifier: "verifier-secret" },
    ]);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("returns account-only login authorization result", async () => {
    let startRequest: DeviceStartRequest | undefined;
    const prompts: ReturnType<typeof buildAuthorizationPrompt>[] = [];
    const client = makeClient({
      start: async (request) => {
        startRequest = request;
        return makeStartResponse();
      },
      token: async () => ({
        status: "approved",
        operation: "login",
        state: testState,
        accountAddress: "0x1111111111111111111111111111111111111111",
      }),
    });

    const result = await authorizeDeviceLogin({
      network: "mainnet",
      walletUrl: "https://account.example",
      walletApiUrl: "https://wallet-api.example",
      relayUrl: "https://relay.example",
      state: testState,
      now: new Date("2026-05-13T12:00:00.000Z"),
      client,
      sleep: async () => undefined,
      onPrompt: (prompt) => prompts.push(prompt),
    });

    expect(startRequest).toMatchObject({
      operation: "login",
      clientName: "mega-cli",
      network: "mainnet",
      state: testState,
      codeChallengeMethod: "S256",
    });
    expect(JSON.stringify(startRequest)).not.toContain(testPrivateKey);
    expect(JSON.stringify(startRequest)).not.toContain("permissions");
    expect(result).toEqual({
      accountAddress: "0x1111111111111111111111111111111111111111",
      authUrl: "https://account.example/cli-auth?code=ABCD-1234",
      relayUrl: "https://relay.example",
      walletUrl: "https://account.example",
    });
    expect(prompts).toEqual([
      {
        verificationUri: "https://account.example/cli-auth",
        verificationUriComplete:
          "https://account.example/cli-auth?code=ABCD-1234",
        userCode: "ABCD-1234",
        expiresAt: "2026-05-13T12:10:00.000Z",
      },
    ]);
  });

  it("returns the loopback-shaped grant authorization result", async () => {
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);
    let startRequest: DeviceStartRequest | undefined;
    const prompts: ReturnType<typeof buildAuthorizationPrompt>[] = [];
    const client = makeClient({
      start: async (request) => {
        startRequest = request;
        return makeStartResponse();
      },
      token: async () =>
        makeGrantApproval({ accessAddress: keyPair.accessAddress }),
    });

    const result = await authorizeDeviceKey({
      network: "mainnet",
      walletUrl: "https://account.example",
      walletApiUrl: "https://wallet-api.example",
      relayUrl: "https://relay.example",
      permissionRequest: testPermissions,
      privateKey: testPrivateKey,
      state: testState,
      now: new Date("2026-05-13T12:00:00.000Z"),
      client,
      sleep: async () => undefined,
      onPrompt: (prompt) => prompts.push(prompt),
    });

    expect(startRequest).toMatchObject({
      operation: "grant",
      clientName: "mega-cli",
      network: "mainnet",
      accessAddress: keyPair.accessAddress,
      permissions: testPermissions,
      state: testState,
      codeChallengeMethod: "S256",
    });
    expect(JSON.stringify(startRequest)).not.toContain(testPrivateKey);
    expect(result).toMatchObject({
      accountAddress: "0x1111111111111111111111111111111111111111",
      authUrl: "https://account.example/cli-auth?code=ABCD-1234",
      relayUrl: "https://relay.example",
      walletUrl: "https://account.example",
      key: {
        id: keyPair.accessAddress,
        accessAddress: keyPair.accessAddress,
        privateKey: testPrivateKey,
        grantTxHash: "0xabcdef",
        status: "active",
        createdAt: "2026-05-13T12:00:00.000Z",
      },
    });
    expect(prompts).toEqual([
      {
        verificationUri: "https://account.example/cli-auth",
        verificationUriComplete:
          "https://account.example/cli-auth?code=ABCD-1234",
        userCode: "ABCD-1234",
        expiresAt: "2026-05-13T12:10:00.000Z",
      },
    ]);
  });

  it("passes testnet through device grant and revoke requests", async () => {
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);
    const startRequests: DeviceStartRequest[] = [];
    const client = makeClient({
      start: async (request) => {
        startRequests.push(request);
        return makeStartResponse();
      },
      token: async () =>
        startRequests.at(-1)?.operation === "revoke"
          ? {
              status: "approved",
              operation: "revoke",
              state: testState,
              accountAddress: "0x1111111111111111111111111111111111111111",
              accessAddress: keyPair.accessAddress,
            }
          : makeGrantApproval({ accessAddress: keyPair.accessAddress }),
    });

    await authorizeDeviceKey({
      network: "testnet",
      walletUrl: "https://account.example",
      walletApiUrl: "https://wallet-api.example",
      relayUrl: "https://relay.example",
      permissionRequest: testPermissions,
      privateKey: testPrivateKey,
      state: testState,
      client,
      sleep: async () => undefined,
    });
    await authorizeDeviceRevoke({
      network: "testnet",
      walletApiUrl: "https://wallet-api.example",
      accountAddress: "0x1111111111111111111111111111111111111111",
      accessAddress: keyPair.accessAddress,
      state: testState,
      client,
      sleep: async () => undefined,
    });

    expect(startRequests.map((request) => request.network)).toEqual([
      "testnet",
      "testnet",
    ]);
  });

  it("rejects grant state, access, and account mismatches", async () => {
    const keyPair = deriveDelegatedKeyPair(testPrivateKey);
    await expect(
      authorizeDeviceKey({
        network: "mainnet",
        walletUrl: "https://account.example",
        walletApiUrl: "https://wallet-api.example",
        relayUrl: "https://relay.example",
        permissionRequest: testPermissions,
        privateKey: testPrivateKey,
        state: testState,
        existingAccountAddress: "0x1111111111111111111111111111111111111111",
        client: makeClient({
          token: async () => makeGrantApproval({ state: "wrong-state" }),
        }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("device authorization state mismatch");

    await expect(
      authorizeDeviceKey({
        network: "mainnet",
        walletUrl: "https://account.example",
        walletApiUrl: "https://wallet-api.example",
        relayUrl: "https://relay.example",
        permissionRequest: testPermissions,
        privateKey: testPrivateKey,
        state: testState,
        client: makeClient({
          token: async () =>
            makeGrantApproval({
              accessAddress: "0x2222222222222222222222222222222222222222",
            }),
        }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("device authorization access address mismatch");

    await expect(
      authorizeDeviceKey({
        network: "mainnet",
        walletUrl: "https://account.example",
        walletApiUrl: "https://wallet-api.example",
        relayUrl: "https://relay.example",
        permissionRequest: testPermissions,
        privateKey: testPrivateKey,
        state: testState,
        existingAccountAddress: "0x3333333333333333333333333333333333333333",
        client: makeClient({
          token: async () =>
            makeGrantApproval({ accessAddress: keyPair.accessAddress }),
        }),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("device authorization account address mismatch");
  });

  it("returns the loopback-shaped revoke authorization result", async () => {
    const starts: DeviceStartRequest[] = [];
    const client = makeClient({
      start: async (request) => {
        starts.push(request);
        return makeStartResponse();
      },
      token: async () => ({
        status: "approved",
        operation: "revoke",
        state: testState,
        accountAddress: "0x1111111111111111111111111111111111111111",
        accessAddress: "0x2222222222222222222222222222222222222222",
        revokeTxHash: "0x1234",
      }),
    });

    await expect(
      authorizeDeviceRevoke({
        network: "mainnet",
        walletApiUrl: "https://wallet-api.example",
        accountAddress: "0x1111111111111111111111111111111111111111",
        accessAddress: "0x2222222222222222222222222222222222222222",
        state: testState,
        client,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual({
      authUrl: "https://account.example/cli-auth?code=ABCD-1234",
      revokeTxHash: "0x1234",
    });
    expect(starts[0]).toMatchObject({
      operation: "revoke",
      accountAddress: "0x1111111111111111111111111111111111111111",
      accessAddress: "0x2222222222222222222222222222222222222222",
      state: testState,
    });
  });

  it("posts device start and token requests through the HTTP client", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: input.toString(),
        body: JSON.parse(init?.body as string),
      });
      return new Response(
        JSON.stringify(
          requests.length === 1
            ? makeStartResponse()
            : { status: "authorization_pending" },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const client = new HttpDeviceAuthClient(
      "https://wallet-api.example/base",
      fetchImpl,
    );
    await client.start({
      operation: "grant",
      clientName: "mega-cli",
      network: "mainnet",
      accessAddress: "0x1111111111111111111111111111111111111111",
      permissions: testPermissions,
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      state: testState,
    });
    await client.token({
      deviceCode: "device-secret",
      codeVerifier: "verifier-secret",
    });

    expect(requests).toEqual([
      {
        url: "https://wallet-api.example/v1/cli-auth/device/start",
        body: expect.objectContaining({
          operation: "grant",
          accessAddress: "0x1111111111111111111111111111111111111111",
        }),
      },
      {
        url: "https://wallet-api.example/v1/cli-auth/device/token",
        body: {
          deviceCode: "device-secret",
          codeVerifier: "verifier-secret",
        },
      },
    ]);
  });
});

function makeClient(
  overrides: Partial<DeviceAuthClient> = {},
): DeviceAuthClient {
  return {
    start: async () => makeStartResponse(),
    token: async () => makeGrantApproval(),
    ...overrides,
  };
}

function makeStartResponse(): DeviceStartResponse {
  return {
    deviceCode: "device-secret",
    userCode: "ABCD-1234",
    verificationUri: "https://account.example/cli-auth",
    verificationUriComplete: "https://account.example/cli-auth?code=ABCD-1234",
    expiresIn: 600,
    interval: 1,
  };
}

function makeGrantApproval(
  overrides: Partial<DeviceTokenResponse & { accessAddress: HexString }> = {},
): DeviceTokenResponse {
  return {
    status: "approved",
    operation: "grant",
    state: testState,
    accountAddress: "0x1111111111111111111111111111111111111111",
    accessAddress: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    authorizedKey: makeAuthorizedKey(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ),
    grantTxHash: "0xabcdef",
    ...overrides,
  };
}

function makeAuthorizedKey(publicKey: HexString): AuthorizedKey {
  return {
    type: "secp256k1",
    role: "session",
    publicKey,
    expiry: 1_800_000_000,
    feeToken: {
      limit: "1",
      symbol: "USDM",
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
