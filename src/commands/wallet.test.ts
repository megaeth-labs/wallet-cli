import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerWalletCommands,
  runWalletKeys,
  runWalletLogout,
  runWalletWhoami,
} from "./wallet.js";
import {
  profileExists,
  readWalletProfile,
  type WalletProfile,
  writeWalletProfile,
} from "../config/profile.js";

const tempDirs: string[] = [];
const activeNow = new Date("2026-05-07T00:00:00.000Z");
const expiredNow = new Date("2030-01-01T00:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet status commands", () => {
  it("reports a missing profile with the login instruction", async () => {
    const env = await tempEnv();

    await expect(
      runWalletWhoami({ network: "mainnet" }, { env, stdout: memoryOutput() }),
    ).rejects.toThrow("no mainnet wallet profile found; run mega wallet login");
  });

  it("rejects testnet before reading wallet profiles", async () => {
    const env = await tempEnv();

    await expect(
      runWalletWhoami({ network: "testnet" }, { env, stdout: memoryOutput() }),
    ).rejects.toThrow(
      "testnet is not supported yet. Omit --network to use mainnet until the wallet path is available.",
    );
  });

  it("shows an expired profile warning without leaking the private key", async () => {
    const env = await tempEnv();
    const profile = makeProfile({ expiry: 1_800_000_000 });
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletWhoami(
      { network: "mainnet" },
      { env, now: () => expiredNow, stdout },
    );

    expect(result.expired).toBe(true);
    expect(stdout.text).toContain(
      "Warning: delegated key expired at 2027-01-15T08:00:00.000Z",
    );
    expect(stdout.text).toContain("Status: expired");
    expect(stdout.text).not.toContain(profile.privateKey);
  });

  it("renders redacted JSON profile output for whoami", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletWhoami(
      { json: true, network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(stdout.text).not.toContain(profile.privateKey);
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("privateKey");
    expect(parsed).toMatchObject({
      accessAddress: profile.accessAddress,
      accountAddress: profile.accountAddress,
      expired: false,
      network: "mainnet",
    });
  });

  it("summarizes delegated keys and approved limits", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletKeys(
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(result.keys).toHaveLength(1);
    expect(stdout.text).toContain("Delegated keys for mainnet:");
    expect(stdout.text).toContain("transfer(address,uint256)");
    expect(stdout.text).toContain("Spend: 100000000000000000/day");
    expect(stdout.text).toContain("Fee token: 1000000000000000 ETH");
    expect(stdout.text).not.toContain(profile.privateKey);
  });

  it("removes the local profile on logout", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletLogout(
      { network: "mainnet", terse: true },
      { env, stdout },
    );

    expect(result).toEqual({
      accessAddress: profile.accessAddress,
      accountAddress: profile.accountAddress,
      network: "mainnet",
      removed: true,
    });
    expect(stdout.text).toBe(`mainnet\tremoved\t${profile.accessAddress}\n`);
    await expect(profileExists("mainnet", env)).resolves.toBe(false);
    await expect(readWalletProfile("mainnet", env)).rejects.toThrow(
      "run mega wallet login",
    );
  });

  it("registers whoami through the command runner with a temp profile dir", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "whoami",
      "--network",
      "mainnet",
      "-t",
    ]);

    expect(stdout.text).toBe(
      `mainnet\t${profile.accountAddress}\t${profile.accessAddress}\tactive\t${profile.authorizedKey.expiry}\n`,
    );
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-status-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function makeProfile(options: { expiry?: number } = {}): WalletProfile {
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
      publicKey: "0x3333333333333333333333333333333333333333",
      expiry: options.expiry ?? 1_800_000_000,
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
