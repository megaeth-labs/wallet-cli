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
import { RelayRpcError, type RelayJsonRpcClient } from "../relay/sendCalls.js";

const privateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const accessAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const accountAddress = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
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
  it("prepares, signs, sends, and polls relay calls in order", async () => {
    const order: string[] = [];
    const profile = makeProfile();
    const client = relayClient(async (method, params) => {
      order.push(method);

      if (method === "wallet_prepareCalls") {
        expect(params).toEqual([
          {
            calls: [
              {
                data: "0x1234",
                to: target,
                value: "0x7",
              },
            ],
            capabilities: {
              meta: {},
            },
            chainId: "0x18c6",
            from: accountAddress,
            key: {
              prehash: false,
              publicKey: accessAddress,
              type: "secp256k1",
            },
          },
        ]);

        return preparedResponse();
      }

      if (method === "wallet_sendPreparedCalls") {
        expect(order).toEqual(["wallet_prepareCalls", "sign", method]);
        expect(params).toEqual([
          {
            capabilities: {
              feeSignature:
                "0x8888888888888888888888888888888888888888888888888888888888888888",
            },
            context: {
              preCall: undefined,
              quote: {
                id: "quote-1",
              },
            },
            key: {
              prehash: false,
              publicKey: accessAddress,
              type: "secp256k1",
            },
            signature,
          },
        ]);

        return { id: bundleId };
      }

      if (method === "wallet_getCallsStatus") {
        expect(params).toEqual([bundleId]);
        return order.filter((entry) => entry === "wallet_getCallsStatus")
          .length === 1
          ? {
              id: bundleId,
              status: "0x64",
            }
          : confirmedStatus();
      }

      throw new Error(`unexpected method ${method}`);
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
        network: "testnet",
        pollIntervalMs: 1,
        timeoutMs: 1_000,
      },
      dependencies({
        client,
        profile,
        signDigest: async (_key, payload) => {
          order.push("sign");
          expect(payload).toBe(digest);
          return signature;
        },
        sleep,
      }),
    );

    expect(result).toMatchObject({
      accessAddress,
      accountAddress,
      id: bundleId,
      network: "testnet",
      status: 200,
    });
    expect(result.receipts?.[0]?.transactionHash).toBe(txHash);
    expect(order).toEqual([
      "wallet_prepareCalls",
      "sign",
      "wallet_sendPreparedCalls",
      "wallet_getCallsStatus",
      "wallet_getCallsStatus",
    ]);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("maps relay authorization failures to delegated-key errors", async () => {
    const client = relayClient(async () => {
      throw new RelayRpcError("execution reverted: UnauthorizedCall()");
    });

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: "0x", to: target }],
          network: "testnet",
        },
        dependencies({ client }),
      ),
    ).rejects.toThrow("permission not granted for delegated key");
  });

  it("rejects expired profiles before contacting the relay", async () => {
    const client = relayClient(vi.fn());

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: "0x", to: target }],
          network: "testnet",
        },
        dependencies({
          client,
          now: () => new Date("2026-05-07T00:00:00.000Z"),
          profile: makeProfile({ expiry: 1_700_000_000 }),
        }),
      ),
    ).rejects.toThrow("wallet profile expired");

    expect(client.request).not.toHaveBeenCalled();
  });

  it("redacts relay failure messages without leaking private key material", async () => {
    const longCalldata = `0x${"aa".repeat(64)}`;
    const client = relayClient(async () => {
      throw new Error(`relay rejected ${longCalldata} with key ${privateKey}`);
    });

    await expect(
      executeWalletCalls(
        {
          calls: [{ data: longCalldata, to: target }],
          network: "testnet",
        },
        dependencies({ client }),
      ),
    ).rejects.toThrow(
      "relay execution failed: relay rejected 0xaaaaaaaa...aaaaaa with key 0x00000000...000001",
    );
  });

  it("registers the reachable wallet execute command", async () => {
    const client = relayClient(async (method) => {
      if (method === "wallet_prepareCalls") {
        return preparedResponse({ capabilities: {} });
      }
      if (method === "wallet_sendPreparedCalls") {
        return { id: bundleId };
      }
      if (method === "wallet_getCallsStatus") {
        return confirmedStatus();
      }

      throw new Error(`unexpected method ${method}`);
    });
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");
    registerExecuteCommand(
      wallet,
      dependencies({
        client,
        signDigest: async () => signature,
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
    const client = relayClient(async (method, params) => {
      if (method === "wallet_prepareCalls") {
        expect(params).toEqual([
          {
            calls: [
              {
                data: "0x",
                to: target,
                value: "0x3",
              },
            ],
            capabilities: {
              meta: {},
            },
            chainId: "0x18c6",
            from: accountAddress,
            key: {
              prehash: false,
              publicKey: accessAddress,
              type: "secp256k1",
            },
          },
        ]);

        return preparedResponse({ capabilities: {} });
      }
      if (method === "wallet_sendPreparedCalls") {
        return { id: bundleId };
      }
      if (method === "wallet_getCallsStatus") {
        return confirmedStatus();
      }

      throw new Error(`unexpected method ${method}`);
    });
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");
    registerExecuteCommand(
      wallet,
      dependencies({
        client,
        signDigest: async () => signature,
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
  client: RelayJsonRpcClient;
  now?: () => Date;
  profile?: WalletProfile;
  signDigest?: ExecuteCommandDependencies["signDigest"];
  sleep?: (ms: number) => Promise<void>;
  stdout?: { write(chunk: string): void };
}): ExecuteCommandDependencies {
  return {
    createRelayClient: () => options.client,
    now: options.now,
    readProfile: async () => options.profile ?? makeProfile(),
    signDigest: options.signDigest ?? (async () => signature),
    sleep: options.sleep,
    stdout: options.stdout,
  };
}

function relayClient(
  handler: (
    method: string,
    params: readonly unknown[],
  ) => Promise<unknown> | unknown,
): RelayJsonRpcClient & {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params: readonly unknown[]) =>
    handler(method, params),
  );

  return {
    request: request as unknown as RelayJsonRpcClient["request"] &
      ReturnType<typeof vi.fn>,
  };
}

function preparedResponse(
  overrides: Partial<{
    capabilities: Record<string, unknown>;
  }> = {},
): Record<string, unknown> {
  return {
    capabilities: overrides.capabilities ?? {
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
    signature:
      "0x9999999999999999999999999999999999999999999999999999999999999999",
    typedData: {},
  };
}

function confirmedStatus(): Record<string, unknown> {
  return {
    id: bundleId,
    receipts: [
      {
        blockHash:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        blockNumber: "0x1",
        chainId: "0x18c6",
        gasUsed: "0x5208",
        logs: [],
        status: "0x1",
        transactionHash: txHash,
      },
    ],
    status: "0xc8",
  };
}

function makeProfile(
  overrides: Partial<{
    expiry: number;
  }> = {},
): WalletProfile {
  return {
    version: 1,
    network: "testnet",
    accountAddress,
    accessAddress,
    privateKey,
    authorizedKey: {
      type: "secp256k1",
      role: "session",
      publicKey: accessAddress,
      expiry: overrides.expiry ?? 1_900_000_000,
      permissions: {
        calls: [
          {
            to: target,
            signature: "transfer(address,uint256)",
          },
        ],
        spend: [],
      },
    },
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
