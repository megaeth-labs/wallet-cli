import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeWalletCalls,
  registerExecuteCommand,
  type ExecuteCommandDependencies,
} from "./execute.js";
import type { WalletProfile } from "../config/profile.js";
import type {
  PortoRelayActions,
  PortoRelayClient,
  PreparedRelayCalls,
} from "../relay/sendCalls.js";
import type { RelaySessionKey } from "../relay/sessionKey.js";

const privateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const accessAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const accountAddress = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const feeToken = "0x3333333333333333333333333333333333333333";
const bundleId =
  "0x4444444444444444444444444444444444444444444444444444444444444444";
const txHash =
  "0x5555555555555555555555555555555555555555555555555555555555555555";
const digest =
  "0x6666666666666666666666666666666666666666666666666666666666666666";
const signature =
  "0x7777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777777";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet execute", () => {
  it("reconstructs a Porto session key and runs relay actions in order", async () => {
    const order: string[] = [];
    const prepared = preparedResponse();
    const client = { name: "porto-client" };
    const relayActions = fakeRelayActions({
      prepareCalls: async (actualClient, params) => {
        order.push("prepare");
        expect(actualClient).toBe(client);
        expect(params.account).toBe(accountAddress);
        expect(params.calls).toEqual([
          {
            data: "0x1234",
            to: target,
            value: 7n,
          },
        ]);
        expect(params.feeToken).toBe(feeToken);
        expect(params.key.type).toBe("secp256k1");
        expect(params.key.role).toBe("session");
        expect(params.key.publicKey).toBe(accessAddress);
        expect(params.key.privateKey?.()).toBe(privateKey);
        expect(params.key.expiry).toBe(1_900_000_000);
        expect(params.key.feeToken).toEqual({
          limit: "1",
          symbol: "ETH",
        });
        expect(params.key.permissions?.calls).toEqual([
          {
            signature: "transfer(address,uint256)",
            to: target,
          },
        ]);
        expect(params.key.permissions?.spend).toEqual([
          {
            limit: 5n,
            period: "day",
            token: feeToken,
          },
        ]);
        return prepared;
      },
      signCalls: async (actualPrepared, params) => {
        order.push("sign");
        expect(actualPrepared).toBe(prepared);
        expect(params.key.publicKey).toBe(accessAddress);
        return signature;
      },
      sendPreparedCalls: async (actualClient, params) => {
        order.push("send");
        expect(actualClient).toBe(client);
        expect(params).toEqual({
          ...prepared,
          signature,
        });
        return { id: bundleId };
      },
      getCallsStatus: async (actualClient, params) => {
        order.push("status");
        expect(actualClient).toBe(client);
        expect(params).toEqual({ id: bundleId });
        return order.filter((entry) => entry === "status").length === 1
          ? {
              id: bundleId,
              status: 100,
            }
          : confirmedStatus();
      },
    });
    const sleep = vi.fn(async () => undefined);

    const result = await executeWalletCalls(
      {
        calls: [
          {
            data: "0x1234",
            to: target,
            value: "7",
          },
        ],
        network: "mainnet",
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      },
      dependencies({
        client,
        relayActions,
        sleep,
      }),
    );

    expect(result).toMatchObject({
      accessAddress,
      accountAddress,
      id: bundleId,
      network: "mainnet",
      status: 200,
    });
    expect(result.receipts?.[0]?.transactionHash).toBe(txHash);
    expect(order).toEqual(["prepare", "sign", "send", "status", "status"]);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("maps relay authorization failures to delegated-key errors", async () => {
    const relayActions = fakeRelayActions({
      prepareCalls: async () => {
        throw new Error("execution reverted: UnauthorizedCall()");
      },
    });

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: "0x", to: target }],
          network: "mainnet",
        },
        dependencies({ relayActions }),
      ),
    ).rejects.toThrow("permission not granted for delegated key");
  });

  it("rejects expired profiles before reconstructing relay actions", async () => {
    const relayActions = fakeRelayActions();

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: "0x", to: target }],
          network: "mainnet",
        },
        dependencies({
          now: () => new Date("2026-05-07T00:00:00.000Z"),
          profile: makeProfile({ expiry: 1_700_000_000 }),
          relayActions,
        }),
      ),
    ).rejects.toThrow("is expired");

    expect(relayActions.prepareCalls).not.toHaveBeenCalled();
  });

  it("explains how to recover when a profile has no delegated keys", async () => {
    const relayActions = fakeRelayActions();

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: "0x", to: target }],
          network: "mainnet",
        },
        dependencies({
          profile: {
            ...makeProfile(),
            activeKeyId: undefined,
            keys: [],
          },
          relayActions,
        }),
      ),
    ).rejects.toThrow(
      "wallet profile has no delegated keys; run mega wallet create-key",
    );

    expect(relayActions.prepareCalls).not.toHaveBeenCalled();
  });

  it("redacts relay failure messages without leaking private key material", async () => {
    const longCalldata = `0x${"aa".repeat(64)}`;
    const relayActions = fakeRelayActions({
      prepareCalls: async () => {
        throw new Error(
          `relay rejected ${longCalldata} with key ${privateKey}`,
        );
      },
    });

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: longCalldata, to: target }],
          network: "mainnet",
        },
        dependencies({ relayActions }),
      ),
    ).rejects.toThrow(
      "relay execution failed: relay rejected 0xaaaaaaaa...aaaaaa with key 0x00000000...000001",
    );
  });

  it("registers the reachable wallet execute command", async () => {
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");
    registerExecuteCommand(
      wallet,
      dependencies({
        relayActions: fakeRelayActions(),
        stdout,
      }),
    );

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "execute",
      "--to",
      target,
      "--data",
      "0x",
      "--value",
      "0",
      "--poll-interval-ms",
      "1",
      "-t",
    ]);

    expect(stdout.text).toBe(`${bundleId}\t200\t${txHash}\n`);
  });

  it("loads call bundles from a JSON file", async () => {
    const callsPath = await writeCallsFile([
      {
        to: target,
        value: "3",
      },
    ]);
    const relayActions = fakeRelayActions({
      prepareCalls: async (_client, params) => {
        expect(params.calls).toEqual([
          {
            data: "0x",
            to: target,
            value: 3n,
          },
        ]);
        return preparedResponse();
      },
    });
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");
    registerExecuteCommand(
      wallet,
      dependencies({
        relayActions,
        stdout,
      }),
    );

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "execute",
      "--calls",
      callsPath,
      "-t",
    ]);

    expect(stdout.text).toBe(`${bundleId}\t200\t${txHash}\n`);
  });
});

function dependencies(options: {
  client?: PortoRelayClient;
  now?: () => Date;
  profile?: WalletProfile;
  relayActions?: PortoRelayActions;
  sleep?: (ms: number) => Promise<void>;
  stdout?: { write(chunk: string): void };
}): ExecuteCommandDependencies {
  return {
    createRelayClient: () => options.client ?? {},
    now: options.now,
    readProfile: async () => options.profile ?? makeProfile(),
    relayActions: options.relayActions ?? fakeRelayActions(),
    sleep: options.sleep,
    stdout: options.stdout,
  };
}

function fakeRelayActions(
  overrides: Partial<PortoRelayActions> = {},
): PortoRelayActions & {
  getCallsStatus: ReturnType<typeof vi.fn>;
  prepareCalls: ReturnType<typeof vi.fn>;
  sendPreparedCalls: ReturnType<typeof vi.fn>;
  signCalls: ReturnType<typeof vi.fn>;
} {
  return {
    getCallsStatus: vi.fn(async () => confirmedStatus()),
    prepareCalls: vi.fn(async () => preparedResponse()),
    sendPreparedCalls: vi.fn(async () => ({ id: bundleId })),
    signCalls: vi.fn(async () => signature),
    ...overrides,
  } as PortoRelayActions & {
    getCallsStatus: ReturnType<typeof vi.fn>;
    prepareCalls: ReturnType<typeof vi.fn>;
    sendPreparedCalls: ReturnType<typeof vi.fn>;
    signCalls: ReturnType<typeof vi.fn>;
  };
}

function preparedResponse(): PreparedRelayCalls {
  return {
    capabilities: {
      feeSignature:
        "0x8888888888888888888888888888888888888888888888888888888888888888",
    },
    context: {
      quote: {
        id: "quote-1",
      },
    },
    digest,
    key: {
      prehash: false,
      publicKey: accessAddress,
      type: "secp256k1",
    },
  };
}

function confirmedStatus(): Awaited<
  ReturnType<PortoRelayActions["getCallsStatus"]>
> {
  return {
    id: bundleId,
    receipts: [
      {
        blockHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        blockNumber: 1,
        chainId: 4326,
        gasUsed: 21_000,
        logs: [],
        status: "0x1",
        transactionHash: txHash,
      },
    ],
    status: 200,
  };
}

function makeProfile(
  overrides: Partial<{
    expiry: number;
  }> = {},
): WalletProfile {
  return {
    version: 1,
    network: "mainnet",
    accountAddress,
    activeKeyId: accessAddress,
    keys: [
      {
        id: accessAddress,
        accessAddress,
        privateKey,
        authorizedKey: {
          type: "secp256k1",
          role: "session",
          publicKey: accessAddress,
          expiry: overrides.expiry ?? 1_900_000_000,
          feeToken: {
            limit: "1",
            symbol: "ETH",
          },
          permissions: {
            calls: [
              {
                to: target,
                signature: "transfer(address,uint256)",
              },
            ],
            spend: [
              {
                limit: "5",
                period: "day",
                token: feeToken,
              },
            ],
          },
        },
        status: "active",
        createdAt: "2026-05-07T00:00:00.000Z",
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    ],
    relayUrl: "https://relay.example",
    walletUrl: "https://wallet.example",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
  };
}

function memoryOutput(): { text: string; write(chunk: string): void } {
  return {
    text: "",
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}

async function writeCallsFile(calls: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-execute-"));
  tempDirs.push(dir);
  const path = join(dir, "calls.json");
  await writeFile(path, `${JSON.stringify(calls)}\n`, "utf8");

  return path;
}
