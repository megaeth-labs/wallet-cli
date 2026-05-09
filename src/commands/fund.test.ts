import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerFundCommand, runWalletFund } from "./fund.js";
import { registerWalletCommands } from "./wallet.js";
import { writeWalletProfile, type WalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet fund", () => {
  it("opens the wallet deposit route for the active account", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const openBrowser = vi.fn(async () => undefined);
    await writeWalletProfile(profile, env);

    const result = await runWalletFund(
      { network: "mainnet" },
      { env, openBrowser, stdout },
    );

    expect(result).toEqual({
      accountAddress: profile.accountAddress,
      fundingUrl:
        "https://wallet.example/deposit?address=0x1111111111111111111111111111111111111111&network=mainnet&source=mega-cli",
      network: "mainnet",
      opened: true,
    });
    expect(openBrowser).toHaveBeenCalledWith(result.fundingUrl);
    expect(stdout.text).toContain("Funding page opened.");
    expect(stdout.text).not.toContain(profile.privateKey);
  });

  it("can print the funding URL without opening a browser", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const openBrowser = vi.fn(async () => undefined);
    await writeWalletProfile(profile, env);

    await runWalletFund(
      { json: true, network: "mainnet", open: false },
      { env, openBrowser, stdout },
    );

    expect(openBrowser).not.toHaveBeenCalled();
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      accountAddress: profile.accountAddress,
      network: "mainnet",
      opened: false,
    });
    expect(parsed.fundingUrl).toBe(
      "https://wallet.example/deposit?address=0x1111111111111111111111111111111111111111&network=mainnet&source=mega-cli",
    );
  });

  it("registers fund into the wallet command registry", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);
    const program = new Command();
    program.exitOverride();

    registerWalletCommands(program, {
      env,
      fund: {
        openBrowser: vi.fn(async () => undefined),
      },
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "fund",
      "--no-open",
      "-t",
    ]);

    expect(stdout.text).toBe(
      "mainnet\t0x1111111111111111111111111111111111111111\tready\thttps://wallet.example/deposit?address=0x1111111111111111111111111111111111111111&network=mainnet&source=mega-cli\n",
    );
  });

  it("registers the standalone fund subcommand", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");

    registerFundCommand(wallet, {
      env,
      openBrowser: vi.fn(async () => undefined),
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "fund",
      "--no-open",
      "-t",
    ]);

    expect(stdout.text).toContain("\tready\thttps://wallet.example/deposit");
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-fund-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function makeProfile(): WalletProfile {
  return {
    version: 1,
    network: "mainnet",
    accountAddress: "0x1111111111111111111111111111111111111111",
    accessAddress: "0x2222222222222222222222222222222222222222",
    privateKey:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authorizedKey: {
      type: "secp256k1",
      role: "session",
      publicKey: "0x2222222222222222222222222222222222222222",
      expiry: 1_800_000_000,
      feeToken: {
        limit: "0.01",
        symbol: "ETH",
      },
      permissions: {
        calls: [],
        spend: [],
      },
    },
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
