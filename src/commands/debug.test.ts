import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDebugCommand, runWalletDebug } from "./debug.js";
import { registerWalletCommands } from "./wallet.js";
import { writeWalletProfile, type WalletProfile } from "../config/profile.js";
import type { EthReadClient } from "../eth/client.js";
import type {
  PortoRelayActions,
  PortoRelayClient,
} from "../relay/sendCalls.js";

const privateKey =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const accessAddress = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const accountAddress = "0x1111111111111111111111111111111111111111";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet debug", () => {
  it("renders local profile, balance, and relay key diagnostics", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const relayClient = {};
    const getKeys = vi.fn(async () => [
      {
        expiry: profile.keys[0]!.authorizedKey.expiry,
        id: profile.keys[0]!.accessAddress,
        publicKey: profile.keys[0]!.accessAddress,
        role: "session",
      },
    ]);
    await writeWalletProfile(profile, env);

    const result = await runWalletDebug(
      { json: true, network: "mainnet" },
      {
        createReadClient: () => fakeReadClient(123n),
        createRelayClient: () => relayClient,
        env,
        now: () => new Date("2026-05-07T00:00:00.000Z"),
        relayActions: { getKeys } as unknown as PortoRelayActions,
        stdout,
      },
    );

    expect(result.delegatedKey.localStatus).toBe("active");
    expect(result.delegatedKey.chainStatus).toBe("authorized");
    expect(result.nativeBalance).toEqual({
      status: "available",
      symbol: "ETH",
      wei: "123",
    });
    expect(getKeys).toHaveBeenCalledWith(relayClient, {
      account: profile.accountAddress,
      chainIds: [4326],
    });
    expect(stdout.text).not.toContain(privateKey);
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("privateKey");
    expect(parsed).toMatchObject({
      accessAddress,
      accountAddress,
      grantTxHash:
        "0x3333333333333333333333333333333333333333333333333333333333333333",
      network: "mainnet",
      profileMode: "0600",
    });
  });

  it("formats human balance output with wei and ETH units", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletDebug(
      { network: "mainnet" },
      {
        createReadClient: () => fakeReadClient(123n),
        createRelayClient: () => ({}),
        env,
        now: () => new Date("2026-05-07T00:00:00.000Z"),
        relayActions: {
          getKeys: vi.fn(async () => []),
        } as unknown as PortoRelayActions,
        stdout,
      },
    );

    expect(stdout.text).toContain(
      "Native balance: 123 wei (0.000000000000000123 ETH)",
    );
  });

  it("can skip chain probes for offline diagnostics", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const createReadClient = vi.fn(() => fakeReadClient(0n));
    const createRelayClient = vi.fn(() => ({}));
    await writeWalletProfile(profile, env);

    const result = await runWalletDebug(
      { network: "mainnet", skipChain: true, terse: true },
      {
        createReadClient,
        createRelayClient,
        env,
        now: () => new Date("2026-05-07T00:00:00.000Z"),
        stdout,
      },
    );

    expect(createReadClient).not.toHaveBeenCalled();
    expect(createRelayClient).not.toHaveBeenCalled();
    expect(result.delegatedKey.chainStatus).toBe("skipped");
    expect(result.nativeBalance.status).toBe("skipped");
    expect(stdout.text).toBe(
      `mainnet\t${accountAddress}\t${accessAddress}\tactive\tskipped\tskipped\n`,
    );
  });

  it("explains how to recover when a profile has no delegated keys", async () => {
    const env = await tempEnv();
    await writeWalletProfile(
      {
        ...makeProfile(),
        activeKeyId: undefined,
        keys: [],
      },
      env,
    );

    await expect(
      runWalletDebug(
        { network: "mainnet", skipChain: true },
        {
          env,
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow(
      "wallet profile has no delegated keys; run mega wallet create-key",
    );
  });

  it("registers debug into the wallet command registry", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);
    const program = new Command();
    program.exitOverride();

    registerWalletCommands(program, {
      debug: {
        createReadClient: () => fakeReadClient(1n),
        relayActions: {
          getKeys: vi.fn(async () => []),
        } as unknown as PortoRelayActions,
      },
      env,
      now: () => new Date("2026-05-07T00:00:00.000Z"),
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "debug",
      "--skip-chain",
      "-t",
    ]);

    expect(stdout.text).toContain(
      `mainnet\t${accountAddress}\t${accessAddress}`,
    );
  });

  it("registers the standalone debug subcommand", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");

    registerDebugCommand(wallet, {
      env,
      now: () => new Date("2026-05-07T00:00:00.000Z"),
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "debug",
      "--skip-chain",
      "-t",
    ]);

    expect(stdout.text).toContain("\tactive\tskipped\tskipped");
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-debug-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function fakeReadClient(balance: bigint): EthReadClient {
  return {
    async call() {
      return "0x";
    },
    async getBalance() {
      return balance;
    },
  };
}

function makeProfile(): WalletProfile {
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
          expiry: 1_800_000_000,
          feeToken: {
            limit: "0.01",
            symbol: "ETH",
          },
          permissions: {
            calls: [
              {
                signature: "transfer(address,uint256)",
                to: "0x2222222222222222222222222222222222222222",
              },
            ],
            spend: [
              {
                limit: "1000000",
                period: "week",
                token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
              },
            ],
          },
        },
        grantTxHash:
          "0x3333333333333333333333333333333333333333333333333333333333333333",
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
