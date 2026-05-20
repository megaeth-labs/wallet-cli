import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import {
  login,
  registerWalletCommands,
  runWalletCreateKey,
  runWalletList,
  runWalletLogout,
  runWalletPermissions,
  runWalletRevoke,
  runWalletSwitch,
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

  it("shows the recovery command when a profile has no delegated keys", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    await writeWalletProfile(
      {
        ...makeProfile(),
        activeKeyId: undefined,
        keys: [],
      },
      env,
    );

    await runWalletWhoami(
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(stdout.text).toBe(
      "No delegated keys for mainnet. Run mega wallet create-key to authorize one.\n",
    );
  });

  it("refuses login when a wallet profile already exists", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    await writeWalletProfile(profile, env);

    await expect(
      login(
        {
          network: "mainnet",
          timeoutMs: 1_000,
        },
        { env },
      ),
    ).rejects.toThrow(
      "Wallet already connected to 0x1111...1111. Either logout with `mega wallet logout` or add a key to the existing wallet profile with `mega wallet create-key`.",
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

    expect(result.activeKey?.expired).toBe(true);
    expect(stdout.text).toContain(
      "Warning: delegated key expired at 2027-01-15T08:00:00.000Z",
    );
    expect(stdout.text).toContain("Status: expired");
    expect(stdout.text).not.toContain(profile.keys[0]!.privateKey);
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

    expect(stdout.text).not.toContain(profile.keys[0]!.privateKey);
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("privateKey");
    expect(parsed).toMatchObject({
      accountAddress: profile.accountAddress,
      network: "mainnet",
    });
    expect((parsed.activeKey as Record<string, unknown>).accessAddress).toBe(
      profile.keys[0]!.accessAddress,
    );
  });

  it("summarizes delegated keys and approved limits", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletList(
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(result.keys).toHaveLength(1);
    expect(stdout.text).toContain("Delegated keys for mainnet:");
    expect(stdout.text).toContain("active, default");
    expect(stdout.text).not.toContain(profile.keys[0]!.privateKey);
  });

  it("renders delegated key permissions in plain English", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletPermissions(
      profile.keys[0]!.id,
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(result.permissionLines).toContain(
      "Can call transfer(address,uint256) on 0x4444...4444",
    );
    expect(stdout.text).toContain("Can spend up to 0.1 0x5555...5555 per day");
    expect(stdout.text).toContain(
      "Can pay up to 1000000000000000 ETH in relay fees",
    );
  });

  it("renders USDm consistently in delegated key permission summaries", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const key = profile.keys[0]!;
    key.authorizedKey.feeToken = {
      limit: "1",
      symbol: "USDM",
    };
    key.authorizedKey.permissions.spend = [
      {
        limit: "100000000000000000000",
        period: "week",
        token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
      },
    ];
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletPermissions(
      key.id,
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(stdout.text).toContain("Can spend up to 100 USDm per week");
    expect(stdout.text).toContain("Can pay up to 1 USDm in relay fees");
    expect(stdout.text).not.toContain("USDM");
  });

  it("switches the default key without deleting older keys", async () => {
    const env = await tempEnv();
    const first = makeProfile();
    const second = makeKey({
      id: "0x7777777777777777777777777777777777777777",
      accessAddress: "0x7777777777777777777777777777777777777777",
      privateKey:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const stdout = memoryOutput();
    await writeWalletProfile(
      {
        ...first,
        keys: [...first.keys, second],
      },
      env,
    );

    const result = await runWalletSwitch(
      second.id,
      { network: "mainnet", terse: true },
      { env, now: () => activeNow, stdout },
    );

    expect(result.key.id).toBe(second.id);
    expect(stdout.text).toBe(`mainnet\t${second.id}\n`);
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      activeKeyId: second.id,
      keys: [{ id: first.keys[0]!.id }, { id: second.id }],
    });
  });

  it("creates a new delegated key and makes it the default", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    await writeWalletProfile(profile, env);

    const result = await runWalletCreateKey(
      {
        allowCall: [
          "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
        ],
        label: "agent",
        network: "mainnet",
        timeoutMs: 1_000,
        terse: true,
      },
      {
        authorizeKey: async (options) => {
          expect(options.walletUrl).toBe(profile.walletUrl);
          expect(options.relayUrl).toBe(profile.relayUrl);
          return {
            accountAddress: profile.accountAddress,
            authUrl: "https://wallet.example/cli-auth/loopback",
            key: created,
            relayUrl: profile.relayUrl,
            walletUrl: profile.walletUrl,
          };
        },
        env,
        now: () => activeNow,
        stdout,
      },
    );

    expect(result.key.id).toBe(created.id);
    expect(stdout.text).toBe(
      `mainnet\t${created.id}\t${created.accessAddress}\n`,
    );
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      activeKeyId: created.id,
      keys: [{ id: profile.keys[0]!.id }, { id: created.id, label: "agent" }],
    });
  });

  it("refuses to copy permissions from a no-call delegated key", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    profile.keys[0]!.authorizedKey.permissions.calls = [];
    await writeWalletProfile(profile, env);

    await expect(
      runWalletCreateKey(
        {
          allowCall: [],
          from: profile.keys[0]!.id,
          network: "mainnet",
          timeoutMs: 1_000,
        },
        {
          authorizeKey: async () => {
            throw new Error("authorizeKey should not be called");
          },
          env,
          now: () => activeNow,
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow(
      "permissions.calls must be present and include at least one call",
    );
  });

  it("requires explicit call scope for default create-key requests", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    await writeWalletProfile(profile, env);

    await expect(
      runWalletCreateKey(
        {
          allowCall: [],
          network: "mainnet",
          spendLimit: "25",
          timeoutMs: 1_000,
        },
        {
          authorizeKey: async () => {
            throw new Error("authorizeKey should not be called");
          },
          env,
          now: () => activeNow,
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow("Use create-key --allow-call");
  });

  it("refuses to copy permissions from a delegated key with omitted calls", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    delete profile.keys[0]!.authorizedKey.permissions.calls;
    await writeWalletProfile(profile, env);

    await expect(
      runWalletCreateKey(
        {
          allowCall: [],
          from: profile.keys[0]!.id,
          network: "mainnet",
          timeoutMs: 1_000,
        },
        {
          authorizeKey: async () => {
            throw new Error("authorizeKey should not be called");
          },
          env,
          now: () => activeNow,
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow(
      "permissions.calls must be present and include at least one call",
    );
  });

  it("passes create-key spend limits into the authorization request", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    await writeWalletProfile(profile, env);

    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      authorizeKey: async (options) => {
        expect(options.permissionRequest.permissions.spend).toEqual([
          {
            limit: "12500000000000000000",
            period: "week",
            token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
          },
        ]);
        expect(options.permissionRequest.permissions.calls).toEqual([
          {
            to: "0x4444444444444444444444444444444444444444",
            signature: "transfer(address,uint256)",
          },
        ]);
        return {
          accountAddress: profile.accountAddress,
          authUrl: "https://wallet.example/cli-auth/loopback",
          key: created,
          relayUrl: profile.relayUrl,
          walletUrl: profile.walletUrl,
        };
      },
      env,
      now: () => activeNow,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "create-key",
      "--spend-limit",
      "12.5",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
      "-t",
    ]);

    expect(stdout.text).toBe(
      `mainnet\t${created.id}\t${created.accessAddress}\n`,
    );
  });

  it("creates keys against a testnet profile with testnet default spend token", async () => {
    const env = await tempEnv();
    const profile = makeProfile({ network: "testnet" });
    const stdout = memoryOutput();
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    await writeWalletProfile(profile, env);

    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      authorizeKey: async (options) => {
        expect(options.network).toBe("testnet");
        expect(options.permissionRequest.permissions.spend).toEqual([
          {
            limit: "25000000000000000000",
            period: "week",
            token: "0x15e9f2b0a747ac05c7446559306687085d161e5c",
          },
        ]);
        return {
          accountAddress: profile.accountAddress,
          authUrl: "https://wallet.example/cli-auth/loopback",
          key: created,
          relayUrl: profile.relayUrl,
          walletUrl: profile.walletUrl,
        };
      },
      env,
      now: () => activeNow,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "create-key",
      "--network",
      "testnet",
      "--spend-limit",
      "25",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
      "-t",
    ]);

    expect(stdout.text).toBe(
      `testnet\t${created.id}\t${created.accessAddress}\n`,
    );
    await expect(readWalletProfile("testnet", env)).resolves.toMatchObject({
      activeKeyId: created.id,
      keys: [{ id: profile.keys[0]!.id }, { id: created.id }],
    });
  });

  it("logs in with device auth while keeping JSON stdout parseable", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput();
    const opened: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      authorizeDeviceLogin: async (options) => {
        expect(options.walletUrl).toBe("https://wallet.example");
        expect(options.walletApiUrl).toBe("https://wallet-api.example");
        options.onPrompt?.({
          verificationUri: "https://wallet.example/cli-auth",
          verificationUriComplete:
            "https://wallet.example/cli-auth?code=ABCD-1234",
          userCode: "ABCD-1234",
          expiresAt: "2026-05-07T00:10:00.000Z",
        });
        return {
          accountAddress: "0x1111111111111111111111111111111111111111",
          authUrl: "https://wallet.example/cli-auth?code=ABCD-1234",
          relayUrl: "https://relay.example",
          walletUrl: "https://wallet.example",
        };
      },
      env,
      now: () => activeNow,
      openBrowser: (url) => {
        opened.push(url);
      },
      stderr,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "login",
      "--auth-flow",
      "device",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
      "--no-browser",
      "--json",
    ]);

    const rendered = JSON.parse(stdout.text) as WalletProfile;
    expect(rendered.accountAddress).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(rendered.activeKeyId).toBeUndefined();
    expect(rendered.keys).toEqual([]);
    expect(stderr.text).toContain(
      "Running headless? Go to https://wallet.example/cli-auth and input this code - ABCD-1234",
    );
    expect(stderr.text).not.toContain("deviceCode");
    expect(opened).toEqual([]);
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      walletApiUrl: "https://wallet-api.example",
      keys: [],
    });
  });

  it("creates a device key with profile wallet API URL and no browser", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const stderr = memoryOutput();
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    const opened: string[] = [];
    await writeWalletProfile(profile, env);

    await runWalletCreateKey(
      {
        allowCall: [
          "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
        ],
        authFlow: "device",
        browser: false,
        network: "mainnet",
        timeoutMs: 1_000,
        terse: true,
      },
      {
        authorizeDeviceKey: async (options) => {
          expect(options.existingAccountAddress).toBe(profile.accountAddress);
          expect(options.walletApiUrl).toBe(profile.walletApiUrl);
          options.onPrompt?.({
            verificationUri: "https://wallet.example/cli-auth",
            verificationUriComplete:
              "https://wallet.example/cli-auth?code=WXYZ-9876",
            userCode: "WXYZ-9876",
            expiresAt: "2026-05-07T00:10:00.000Z",
          });
          return {
            accountAddress: profile.accountAddress,
            authUrl: "https://wallet.example/cli-auth?code=WXYZ-9876",
            key: created,
            relayUrl: profile.relayUrl,
            walletUrl: profile.walletUrl,
          };
        },
        env,
        now: () => activeNow,
        openBrowser: (url) => {
          opened.push(url);
        },
        stderr,
        stdout,
      },
    );

    expect(stdout.text).toBe(
      `mainnet\t${created.id}\t${created.accessAddress}\n`,
    );
    expect(stderr.text).toContain("Verification code: WXYZ-9876");
    expect(opened).toEqual([]);
  });

  it("revokes a key on-chain and keeps an inactive audit record", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletRevoke(
      profile.keys[0]!.id,
      { network: "mainnet", terse: true, timeoutMs: 1_000 },
      {
        env,
        now: () => activeNow,
        revokeKey: async (options) => {
          expect(options.accountAddress).toBe(profile.accountAddress);
          expect(options.accessAddress).toBe(profile.keys[0]!.accessAddress);
          return {
            authUrl: "https://wallet.example/cli-auth/revoke",
            revokeTxHash:
              "0x9999999999999999999999999999999999999999999999999999999999999999",
          };
        },
        stdout,
      },
    );

    expect(result.key.effectiveStatus).toBe("revoked");
    expect(stdout.text).toBe(
      `mainnet\t${profile.keys[0]!.id}\trevoked\t0x9999999999999999999999999999999999999999999999999999999999999999\n`,
    );
    const stored = await readWalletProfile("mainnet", env);
    expect(stored.activeKeyId).toBeUndefined();
    expect(stored.keys[0]).toMatchObject({
      id: profile.keys[0]!.id,
      status: "revoked",
      revokedAt: activeNow.toISOString(),
    });
    expect(stored.keys[0]).not.toHaveProperty("privateKey");
  });

  it("revokes a key through device auth", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    const stderr = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletRevoke(
      profile.keys[0]!.id,
      { authFlow: "device", network: "mainnet", terse: true, timeoutMs: 1_000 },
      {
        env,
        now: () => activeNow,
        revokeDeviceKey: async (options) => {
          expect(options.accountAddress).toBe(profile.accountAddress);
          expect(options.accessAddress).toBe(profile.keys[0]!.accessAddress);
          expect(options.walletApiUrl).toBe(profile.walletApiUrl);
          options.onPrompt?.({
            verificationUri: "https://wallet.example/cli-auth",
            verificationUriComplete:
              "https://wallet.example/cli-auth?code=REVK-0001",
            userCode: "REVK-0001",
            expiresAt: "2026-05-07T00:10:00.000Z",
          });
          return {
            authUrl: "https://wallet.example/cli-auth?code=REVK-0001",
            revokeTxHash:
              "0x9999999999999999999999999999999999999999999999999999999999999999",
          };
        },
        stderr,
        stdout,
      },
    );

    expect(stdout.text).toBe(
      `mainnet\t${profile.keys[0]!.id}\trevoked\t0x9999999999999999999999999999999999999999999999999999999999999999\n`,
    );
    expect(stderr.text).toContain("Running headless?");
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
      accountAddress: profile.accountAddress,
      network: "mainnet",
      removed: true,
    });
    expect(stdout.text).toBe("mainnet\tremoved\n");
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

    await program.parseAsync(["node", "mega", "wallet", "whoami", "-t"]);

    expect(stdout.text).toBe(
      `mainnet\t${profile.accountAddress}\t${profile.keys[0]!.accessAddress}\tactive\t${profile.keys[0]!.authorizedKey.expiry}\n`,
    );
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-status-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function makeProfile(
  options: { expiry?: number; network?: WalletProfile["network"] } = {},
): WalletProfile {
  return {
    version: 1,
    network: options.network ?? "mainnet",
    accountAddress: "0x1111111111111111111111111111111111111111",
    activeKeyId: "0x2222222222222222222222222222222222222222",
    keys: [
      makeKey({
        expiry: options.expiry,
      }),
    ],
    walletUrl: "https://wallet.example",
    walletApiUrl: "https://wallet-api.example",
    relayUrl: "https://relay.example",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
  };
}

function makeKey(
  options: {
    accessAddress?: `0x${string}`;
    expiry?: number;
    id?: `0x${string}`;
    privateKey?: `0x${string}`;
  } = {},
): WalletProfile["keys"][number] {
  const accessAddress =
    options.accessAddress ?? "0x2222222222222222222222222222222222222222";
  return {
    id: options.id ?? accessAddress,
    accessAddress,
    privateKey:
      options.privateKey ??
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    authorizedKey: {
      type: "secp256k1",
      role: "session",
      publicKey: accessAddress,
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
    status: "active",
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
