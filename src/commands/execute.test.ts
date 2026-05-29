import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { zeroAddress } from "viem";
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
} from "../relay/sendCalls.js";

const privateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const accessAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const accountAddress = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const feeToken = "0x3333333333333333333333333333333333333333";
const txHash =
  "0x5555555555555555555555555555555555555555555555555555555555555555";
const bundleId = txHash;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet execute", () => {
  it("reconstructs a Porto session key and runs relay actions in order", async () => {
    const order: string[] = [];
    const client = { name: "porto-client" };
    const relayActions = fakeRelayActions({
      sendCalls: async (actualClient, params) => {
        order.push("send");
        expect(actualClient).toBe(client);
        expect(params.account.address).toBe(accountAddress);
        expect(params.calls).toEqual([
          {
            data: "0x1234",
            to: target,
            value: 7n,
          },
        ]);
        expect(params.feeToken).toBe(zeroAddress);
        expect(params.key?.type).toBe("secp256k1");
        expect(params.key?.role).toBe("session");
        expect(params.key?.publicKey).toBe(accessAddress);
        expect(params.key?.privateKey?.()).toBe(privateKey);
        expect(params.key?.expiry).toBe(1_900_000_000);
        expect(params.key?.feeToken).toEqual({
          limit: "1",
          symbol: "ETH",
        });
        expect(params.key?.permissions?.calls).toEqual([
          {
            signature: "transfer(address,uint256)",
            to: target,
          },
        ]);
        expect(params.key?.permissions?.spend).toEqual([
          {
            limit: 5n,
            period: "day",
            token: feeToken,
          },
        ]);
        return receiptResponse();
      },
    });

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
      },
      dependencies({
        client,
        relayActions,
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
    expect(result.transactionHash).toBe(txHash);
    expect(order).toEqual(["send"]);
  });

  it("uses the approved fee token instead of the first spend token", async () => {
    const client = { name: "porto-client" };
    const relayActions = fakeRelayActions({
      getPaymentPerGas: vi.fn(async () => ({
        tokens: [
          {
            address: feeToken,
            feeToken: true,
            paymentPerGas: "0x1",
            symbol: "USDm",
          },
        ],
      })),
      sendCalls: async (_actualClient, params) => {
        expect(params.feeToken).toBe(feeToken);
        expect(params.key?.feeToken).toEqual({
          limit: "1",
          symbol: "USDm",
        });
        expect(params.key?.permissions?.spend).toEqual([
          {
            limit: 5n,
            period: "day",
          },
        ]);
        return receiptResponse();
      },
    });

    await executeWalletCalls(
      {
        calls: [
          {
            data: "0x1234",
            to: target,
            value: "0",
          },
        ],
        network: "mainnet",
      },
      dependencies({
        client,
        profile: makeProfile({
          feeToken: {
            limit: "1",
            symbol: "USDm",
          },
          spend: [
            {
              limit: "5",
              period: "day",
            },
          ],
        }),
        relayActions,
      }),
    );

    expect(relayActions.getPaymentPerGas).toHaveBeenCalledWith(client);
  });

  it("maps relay authorization failures to delegated-key errors", async () => {
    const relayActions = fakeRelayActions({
      sendCalls: async () => {
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

    expect(relayActions.sendCalls).not.toHaveBeenCalled();
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

    expect(relayActions.sendCalls).not.toHaveBeenCalled();
  });

  it("redacts relay failure messages without leaking private key material", async () => {
    const longCalldata = `0x${"aa".repeat(64)}`;
    const relayActions = fakeRelayActions({
      sendCalls: async () => {
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

  it("uses nested relay details when the top-level relay error is generic", async () => {
    const relayActions = fakeRelayActions({
      sendCalls: async () => {
        throw Object.assign(
          new Error("An error occurred while executing calls."),
          {
            details: "execution reverted: ERC20InsufficientAllowance()",
          },
        );
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
    ).rejects.toThrow(
      "relay execution failed: execution reverted: ERC20InsufficientAllowance()",
    );
  });

  it("prints the full transaction hash in text and JSON output", async () => {
    const stdout = memoryOutput();

    await runRegisteredExecute(
      ["--to", target, "--data", "0x", "--value", "0"],
      stdout,
    );

    expect(stdout.text).toContain(`Transaction: ${txHash}`);
    expect(stdout.text).not.toContain("0x55555555...555555");

    const jsonStdout = memoryOutput();
    await runRegisteredExecute(
      ["--to", target, "--data", "0x", "--value", "0", "--json"],
      jsonStdout,
    );

    const parsed = JSON.parse(jsonStdout.text) as {
      id: string;
      receipts: { transactionHash: string }[];
      transactionHash: string;
    };
    expect(parsed.id).toBe("0x55555555...555555");
    expect(parsed.transactionHash).toBe(txHash);
    expect(parsed.receipts[0]?.transactionHash).toBe(txHash);
  });

  it("registers the reachable wallet execute command", async () => {
    const stdout = memoryOutput();
    await runRegisteredExecute(
      ["--to", target, "--data", "0x", "--value", "0", "-t"],
      stdout,
    );

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
      sendCalls: async (_client, params) => {
        expect(params.calls).toEqual([
          {
            data: "0x",
            to: target,
            value: 3n,
          },
        ]);
        return receiptResponse();
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

async function runRegisteredExecute(
  args: string[],
  stdout: { write(chunk: string): void },
  options: { relayActions?: PortoRelayActions } = {},
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const wallet = program.command("wallet");
  registerExecuteCommand(
    wallet,
    dependencies({
      relayActions: options.relayActions ?? fakeRelayActions(),
      stdout,
    }),
  );

  await program.parseAsync([
    "node",
    "mega",
    "wallet",
    "execute",
    ...args,
    "--poll-interval-ms",
    "1",
  ]);
}

function dependencies(options: {
  client?: PortoRelayClient;
  now?: () => Date;
  profile?: WalletProfile;
  relayActions?: PortoRelayActions;
  stdout?: { write(chunk: string): void };
}): ExecuteCommandDependencies {
  return {
    createRelayClient: () => options.client ?? {},
    now: options.now,
    readProfile: async () => options.profile ?? makeProfile(),
    relayActions: options.relayActions ?? fakeRelayActions(),
    stdout: options.stdout,
  };
}

function fakeRelayActions(
  overrides: Partial<PortoRelayActions> = {},
): PortoRelayActions & {
  getPaymentPerGas: ReturnType<typeof vi.fn>;
  sendCalls: ReturnType<typeof vi.fn>;
} {
  return {
    getPaymentPerGas: vi.fn(async () => ({
      tokens: [
        {
          address: zeroAddress,
          feeToken: true,
          paymentPerGas: "0x1",
          symbol: "ETH",
        },
      ],
    })),
    sendCalls: vi.fn(async () => receiptResponse()),
    ...overrides,
  } as PortoRelayActions & {
    getPaymentPerGas: ReturnType<typeof vi.fn>;
    sendCalls: ReturnType<typeof vi.fn>;
  };
}

function receiptResponse(): Awaited<
  ReturnType<PortoRelayActions["sendCalls"]>
> {
  return {
    blockHash:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    blockNumber: "0x1",
    chainId: "0x10e6",
    gasUsed: "0x5208",
    logs: [],
    status: "0x1",
    transactionHash: txHash,
  };
}

function makeProfile(
  overrides: Partial<{
    expiry: number;
    feeToken: WalletProfile["keys"][number]["authorizedKey"]["feeToken"];
    spend: WalletProfile["keys"][number]["authorizedKey"]["permissions"]["spend"];
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
          feeToken: overrides.feeToken ?? {
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
            spend: overrides.spend ?? [
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
