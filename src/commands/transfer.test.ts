import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import {
  registerTransferCommand,
  runWalletTransfer,
  type TransferCommandDependencies,
} from "./transfer.js";
import { registerWalletCommands } from "./wallet.js";
import type {
  ExecuteCommandResult,
  ExecuteWalletCallsOptions,
} from "./execute.js";

const recipient = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const token = "0x1234567890abcdef1234567890abcdef12345678";
const accountAddress = "0x1111111111111111111111111111111111111111";
const accessAddress = "0x2222222222222222222222222222222222222222";
const bundleId =
  "0x3333333333333333333333333333333333333333333333333333333333333333";
const txHash =
  "0x4444444444444444444444444444444444444444444444444444444444444444";

describe("wallet transfer", () => {
  it("maps native ETH transfers to a single execute call with wei value", async () => {
    let captured: ExecuteWalletCallsOptions | undefined;
    const stdout = memoryOutput();

    const result = await runWalletTransfer(
      {
        amount: "0.1",
        network: "mainnet",
        pollIntervalMs: 25,
        timeoutMs: 5_000,
        to: recipient,
        terse: true,
      },
      dependencies({
        executeWalletCalls: async (options) => {
          captured = options;
          return executionResult();
        },
        stdout,
      }),
    );

    expect(captured).toEqual({
      calls: [
        {
          data: "0x",
          to: recipient,
          value: 100000000000000000n,
        },
      ],
      network: "mainnet",
      pollIntervalMs: 25,
      timeoutMs: 5_000,
    });
    expect(result.transfer).toEqual({
      amount: "0.1",
      asset: "native",
      to: recipient,
      value: "100000000000000000",
    });
    expect(stdout.text).toBe(`${bundleId}\t200\t${txHash}\n`);
  });

  it("maps ERC20 transfers to transfer calldata with zero native value", async () => {
    let captured: ExecuteWalletCallsOptions | undefined;

    const result = await runWalletTransfer(
      {
        amount: "100",
        decimals: 18,
        network: "mainnet",
        pollIntervalMs: 1,
        timeoutMs: 1_000,
        to: recipient,
        token,
      },
      dependencies({
        executeWalletCalls: async (options) => {
          captured = options;
          return executionResult();
        },
        stdout: memoryOutput(),
      }),
    );

    expect(captured).toEqual({
      calls: [
        {
          data: "0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd0000000000000000000000000000000000000000000000056bc75e2d63100000",
          to: token,
          value: 0n,
        },
      ],
      network: "mainnet",
      pollIntervalMs: 1,
      timeoutMs: 1_000,
    });
    expect(result.transfer).toEqual({
      amount: "100",
      asset: "erc20",
      decimals: 18,
      to: recipient,
      token,
      units: "100000000000000000000",
    });
  });

  it("resolves ERC20 decimals when no decimals override is provided", async () => {
    let captured: ExecuteWalletCallsOptions | undefined;

    const result = await runWalletTransfer(
      {
        amount: "1.5",
        network: "mainnet",
        pollIntervalMs: 1,
        timeoutMs: 1_000,
        to: recipient,
        token,
      },
      dependencies({
        executeWalletCalls: async (options) => {
          captured = options;
          return executionResult();
        },
        readTokenMetadata: async (options) => {
          expect(options).toEqual({
            network: "mainnet",
            rpcUrl: "https://mainnet.megaeth.com/rpc",
            token,
          });
          return { decimals: 6, symbol: "USDM" };
        },
        stdout: memoryOutput(),
      }),
    );

    expect(captured?.calls[0]).toEqual({
      data: "0xa9059cbb000000000000000000000000abcdefabcdefabcdefabcdefabcdefabcdefabcd000000000000000000000000000000000000000000000000000000000016e360",
      to: token,
      value: 0n,
    });
    expect(result.transfer).toEqual({
      amount: "1.5",
      asset: "erc20",
      decimals: 6,
      symbol: "USDM",
      to: recipient,
      token,
      units: "1500000",
    });
  });

  it("surfaces token metadata failures before executing", async () => {
    const execute = vi.fn(async () => executionResult());

    await expect(
      runWalletTransfer(
        {
          amount: "100",
          network: "mainnet",
          pollIntervalMs: 1,
          timeoutMs: 1_000,
          to: recipient,
          token,
        },
        dependencies({
          executeWalletCalls: execute,
          readTokenMetadata: async () => {
            throw new Error("method not found");
          },
        }),
      ),
    ).rejects.toThrow(
      "failed to read ERC20 decimals; pass --decimals or --rpc-url: method not found",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects testnet before executing transfer calls", async () => {
    const execute = vi.fn(async () => executionResult());

    await expect(
      runWalletTransfer(
        {
          amount: "0.1",
          network: "testnet",
          pollIntervalMs: 1,
          timeoutMs: 1_000,
          to: recipient,
        },
        dependencies({
          executeWalletCalls: execute,
          stdout: memoryOutput(),
        }),
      ),
    ).rejects.toThrow(
      "testnet is not supported yet. Omit --network to use mainnet until the wallet path is available.",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("registers the reachable wallet transfer command", async () => {
    let captured: ExecuteWalletCallsOptions | undefined;
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");

    registerTransferCommand(
      wallet,
      dependencies({
        executeWalletCalls: async (options) => {
          captured = options;
          return executionResult();
        },
        stdout,
      }),
    );

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "transfer",
      "--to",
      recipient,
      "--amount",
      "0.1",
      "--poll-interval-ms",
      "1",
      "-t",
    ]);

    expect(captured?.calls[0]).toEqual({
      data: "0x",
      to: recipient,
      value: 100000000000000000n,
    });
    expect(stdout.text).toBe(`${bundleId}\t200\t${txHash}\n`);
  });

  it("wires transfer into the wallet command registry", async () => {
    let captured: ExecuteWalletCallsOptions | undefined;
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();

    registerWalletCommands(program, {
      transfer: dependencies({
        executeWalletCalls: async (options) => {
          captured = options;
          return executionResult();
        },
        stdout,
      }),
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "transfer",
      "--to",
      recipient,
      "--amount",
      "0.1",
      "--poll-interval-ms",
      "1",
      "-t",
    ]);

    expect(captured?.calls[0]).toEqual({
      data: "0x",
      to: recipient,
      value: 100000000000000000n,
    });
    expect(stdout.text).toBe(`${bundleId}\t200\t${txHash}\n`);
  });
});

function dependencies(
  options: {
    executeWalletCalls?: (
      options: ExecuteWalletCallsOptions,
    ) => Promise<ExecuteCommandResult>;
    readTokenMetadata?: TransferCommandDependencies["readTokenMetadata"];
    stdout?: { write(chunk: string): void };
  } = {},
): TransferCommandDependencies {
  return {
    executeWalletCalls:
      options.executeWalletCalls ??
      vi.fn(async () => {
        throw new Error("unexpected execute call");
      }),
    readTokenMetadata: options.readTokenMetadata,
    stdout: options.stdout,
  };
}

function executionResult(): ExecuteCommandResult {
  return {
    accessAddress,
    accountAddress,
    id: bundleId,
    network: "mainnet",
    receipts: [
      {
        blockHash:
          "0x5555555555555555555555555555555555555555555555555555555555555555",
        blockNumber: 1,
        chainId: 4326,
        gasUsed: 21_000,
        logs: [],
        status: "0x1",
        transactionHash: txHash,
      },
    ],
    relayUrl: "https://relay.example",
    status: 200,
  };
}

function memoryOutput(): { readonly text: string; write(chunk: string): void } {
  let text = "";

  return {
    get text(): string {
      return text;
    },
    write(chunk: string): void {
      text += chunk;
    },
  };
}
