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
  runWalletUpdate,
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
    ).rejects.toThrow("no mainnet wallet profile found; run mega moss login");
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
      [
        "No delegated keys for mainnet.",
        "",
        "Network: mainnet",
        "Account: 0x1111111111111111111111111111111111111111",
        "",
        "Next: mega moss create-key",
        "",
      ].join("\n"),
    );
  });

  it("colorizes human output only when stdout is a TTY", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput({ columns: 100, isTTY: true });
    await writeWalletProfile(profile, env);

    await runWalletWhoami(
      { network: "mainnet" },
      { env, now: () => activeNow, stdout },
    );

    expect(stdout.text).toContain("\x1b[");
    expect(stdout.text).toContain("Network");
    expect(stdout.text).toContain("0x1111111111111111111111111111111111111111");
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
      "Wallet already connected to 0x1111...1111. Either logout with `mega moss logout` or add a key to the existing wallet profile with `mega moss create-key`.",
    );
  });

  it("shows an expired profile warning without leaking the private key", async () => {
    const env = await tempEnv();
    const profile = makeProfile({ expiry: 1_800_000_000 });
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletWhoami(
      { network: "mainnet" },
      {
        env,
        now: () => expiredNow,
        readTokenMetadata: async () => ({}),
        stdout,
      },
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
    profile.keys[0]!.grantTxHash =
      "0x6666666666666666666666666666666666666666666666666666666666666666";
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletWhoami(
      { json: true, network: "mainnet" },
      {
        env,
        now: () => activeNow,
        readTokenMetadata: async () => {
          throw new Error("readTokenMetadata should not be called");
        },
        stdout,
      },
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
    expect((parsed.activeKey as Record<string, unknown>).grantTxHash).toBe(
      profile.keys[0]!.grantTxHash,
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
      {
        env,
        now: () => activeNow,
        readSpendInfos: async () => [],
        readTokenMetadata: async () => ({}),
        stdout,
      },
    );

    expect(result.permissionLines).toContain(
      "Can call transfer(address,uint256) on 0x4444...4444",
    );
    expect(stdout.text).toContain("Can spend up to 0.1 0x5555...5555 per day");
    expect(stdout.text).toContain("Uses ETH for relay fees");
    expect(stdout.text).toContain("Approved scope (stored request):");
    expect(stdout.text).toContain(
      "  - Can call transfer(address,uint256) on 0x4444...4444",
    );
  });

  it("renders delegated key remaining spend from on-chain spend info", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletPermissions(
      profile.keys[0]!.id,
      { network: "mainnet" },
      {
        env,
        now: () => activeNow,
        readSpendInfos: async (options) => {
          expect(options.accountAddress).toBe(profile.accountAddress);
          expect(options.key.id).toBe(profile.keys[0]!.id);
          expect(options.network).toBe("mainnet");

          return [
            {
              current: "1800000000",
              currentSpent: "25000000000000000",
              lastUpdated: "1800000000",
              limit: "100000000000000000",
              period: "day",
              remaining: "75000000000000000",
              spent: "25000000000000000",
              token: "0x5555555555555555555555555555555555555555",
            },
          ];
        },
        readTokenMetadata: async () => ({
          "0x5555555555555555555555555555555555555555": {
            decimals: 18,
          },
        }),
        stdout,
      },
    );

    expect(result.spendInfos).toHaveLength(1);
    expect(stdout.text).toContain("Live on-chain spend remaining:");
    expect(stdout.text).toContain(
      "- 0.075 0x5555...5555 remaining for current day (0.025 of 0.1 spent)",
    );
  });

  it("uses ERC20 decimals and symbols for delegated spend output", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const key = profile.keys[0]!;
    key.authorizedKey.permissions.spend = [
      {
        limit: "1000000",
        period: "week",
        token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
      },
    ];
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletPermissions(
      key.id,
      { network: "mainnet" },
      {
        env,
        now: () => activeNow,
        readSpendInfos: async () => [
          {
            current: "1800000000",
            currentSpent: "250000",
            lastUpdated: "1800000000",
            limit: "1000000",
            period: "week",
            remaining: "750000",
            spent: "250000",
            token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
          },
        ],
        readTokenMetadata: async (options) => {
          expect(options.tokens).toEqual([
            "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
          ]);
          return {
            "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb": {
              decimals: 6,
              symbol: "USDT0",
            },
          };
        },
        stdout,
      },
    );

    expect(stdout.text).toContain("Can spend up to 1 USDT0 per week");
    expect(stdout.text).toContain(
      "- 0.75 USDT0 remaining for current week (0.25 of 1 spent)",
    );
    expect(stdout.text).not.toContain("0.000000000001");
  });

  it("formats native ETH spend with 18 decimals", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const key = profile.keys[0]!;
    key.authorizedKey.permissions.spend = [
      {
        limit: "500000000000000000",
        period: "week",
        token: "0x0000000000000000000000000000000000000000",
      },
    ];
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    await runWalletPermissions(
      key.id,
      { network: "mainnet" },
      {
        env,
        now: () => activeNow,
        readSpendInfos: async () => [
          {
            current: "1800000000",
            currentSpent: "250000000000000000",
            lastUpdated: "1800000000",
            limit: "500000000000000000",
            period: "week",
            remaining: "250000000000000000",
            spent: "250000000000000000",
            token: "0x0000000000000000000000000000000000000000",
          },
        ],
        readTokenMetadata: async (options) => {
          expect(options.tokens).toEqual([]);
          return {};
        },
        stdout,
      },
    );

    expect(stdout.text).toContain("Can spend up to 0.5 ETH per week");
    expect(stdout.text).toContain(
      "- 0.25 ETH remaining for current week (0.25 of 0.5 spent)",
    );
  });

  it("keeps permission output readable when on-chain spend info is unavailable", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletPermissions(
      profile.keys[0]!.id,
      { network: "mainnet" },
      {
        env,
        now: () => activeNow,
        readSpendInfos: async () => {
          throw new Error("RPC unavailable");
        },
        readTokenMetadata: async () => ({}),
        stdout,
      },
    );

    expect(result.spendInfoError).toBe("RPC unavailable");
    expect(stdout.text).toContain("Can spend up to 0.1 0x5555...5555 per day");
    expect(stdout.text).toContain("Live on-chain spend remaining:");
    expect(stdout.text).toContain("  - unavailable (RPC unavailable)");
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
      {
        env,
        now: () => activeNow,
        readSpendInfos: async () => [],
        readTokenMetadata: async () => ({}),
        stdout,
      },
    );

    expect(stdout.text).toContain("Can spend up to 100 USDm per week");
    expect(stdout.text).toContain("Uses USDm for relay fees");
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
      "permissions.calls must be present and include at least one explicit call",
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
          spendLimit: ["0xfafddbb3fc7688494971a79cc65dca3ef82079e7:25:week"],
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
      "permissions.calls must be present and include at least one explicit call",
    );
  });

  it("refuses to copy permissions from a delegated key with broad call scope", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    profile.keys[0]!.authorizedKey.permissions.calls = [{}];
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
      "each permissions.calls entry must include both to and signature",
    );
  });

  it("copies delegated-key permissions with fee-token metadata", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const source = profile.keys[0]!;
    source.authorizedKey.feeToken = {
      limit: "1",
      symbol: "USDM",
    };
    source.authorizedKey.permissions.spend = [
      {
        limit: "100000000000000000000",
        period: "week",
        token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
      },
    ];
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    await writeWalletProfile(profile, env);

    await runWalletCreateKey(
      {
        allowCall: [],
        from: source.id,
        network: "mainnet",
        timeoutMs: 1_000,
      },
      {
        authorizeKey: async (options) => {
          expect(options.permissionRequest.feeToken).toEqual({
            limit: "1",
            symbol: "USDM",
          });
          expect(options.permissionRequest).not.toHaveProperty("maxFeesUSD");
          expect(options.permissionRequest.permissions.spend).toEqual([
            {
              limit: "100000000000000000000",
              period: "week",
              token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
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
        stdout: memoryOutput(),
      },
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
        expect(options.permissionRequest.feeToken).toEqual({
          limit: "1",
          symbol: "USDM",
        });
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
      "moss",
      "create-key",
      "--spend-limit",
      "0xfafddbb3fc7688494971a79cc65dca3ef82079e7:12.5:week",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
      "-t",
    ]);

    expect(stdout.text).toBe(
      `mainnet\t${created.id}\t${created.accessAddress}\n`,
    );
  });

  it("prints the full access address after creating a key", async () => {
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

    await runWalletCreateKey(
      {
        allowCall: [
          "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
        ],
        label: "agent",
        network: "mainnet",
        timeoutMs: 1_000,
      },
      {
        authorizeKey: async () => ({
          accountAddress: profile.accountAddress,
          authUrl: "https://wallet.example/cli-auth/loopback",
          key: created,
          relayUrl: profile.relayUrl,
          walletUrl: profile.walletUrl,
        }),
        env,
        now: () => activeNow,
        stdout,
      },
    );

    expect(stdout.text).toContain(`Access address: ${created.accessAddress}`);
    expect(stdout.text).toContain(
      `Next: mega moss permissions ${created.accessAddress}`,
    );
  });

  it("passes create-key spend token and period overrides into the authorization request", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
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
            limit: "250000",
            period: "day",
            token: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
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
      stdout: memoryOutput(),
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "create-key",
      "--spend-limit",
      "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb:0.25:day",
      "--fee-limit",
      "0",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
    ]);
  });

  it("passes create-key fee-token overrides into the authorization request", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
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
        expect(options.permissionRequest.feeToken).toEqual({
          limit: "0.25",
          symbol: "USDT0",
        });
        expect(options.permissionRequest).not.toHaveProperty("maxFeesUSD");
        expect(options.permissionRequest.permissions.spend).toEqual([
          {
            limit: "12500000000000000000",
            period: "week",
            token: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
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
      stdout: memoryOutput(),
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "create-key",
      "--spend-limit",
      "0xfafddbb3fc7688494971a79cc65dca3ef82079e7:12.5:week",
      "--fee-token",
      "USDT0",
      "--fee-limit",
      "0.25",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
    ]);
  });

  it("does not add default USDM spend when create-key only overrides fees", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
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
        expect(options.permissionRequest.feeToken).toEqual({
          limit: "0.05",
          symbol: "USDT0",
        });
        expect(options.permissionRequest).not.toHaveProperty("maxFeesUSD");
        expect(options.permissionRequest.permissions.spend).toEqual([]);
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
      stdout: memoryOutput(),
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "create-key",
      "--fee-token",
      "USDT0",
      "--fee-limit",
      "0.05",
      "--allow-call",
      "0x4444444444444444444444444444444444444444:withdraw(address,uint256,address)",
    ]);
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
        expect(options.permissionRequest.feeToken).toEqual({
          limit: "1",
          symbol: "USDM",
        });
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
      "moss",
      "create-key",
      "--network",
      "testnet",
      "--spend-limit",
      "0x15e9f2b0a747ac05c7446559306687085d161e5c:25:week",
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

  it("logs in with loopback auth while keeping JSON stdout parseable", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput({ columns: 80, isTTY: true });
    const opened: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      openBrowser: async (url) => {
        opened.push(url);
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirectUri");
        expect(redirectUri).not.toBeNull();
        const callbackUrl = new URL(redirectUri!);
        callbackUrl.searchParams.set(
          "state",
          authUrl.searchParams.get("state")!,
        );
        callbackUrl.searchParams.set("status", "approved");
        callbackUrl.searchParams.set(
          "accountAddress",
          "0x1111111111111111111111111111111111111111",
        );
        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);
      },
      stderr,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
      "--json",
    ]);

    const rendered = JSON.parse(stdout.text) as WalletProfile;
    expect(rendered.accountAddress).toBe(
      "0x1111111111111111111111111111111111111111",
    );
    expect(rendered.activeKeyId).toBeUndefined();
    expect(rendered.keys).toEqual([]);
    expect(opened).toHaveLength(1);
    expect(stderr.text).toBe("");
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      walletApiUrl: "https://wallet-api.example",
      keys: [],
    });
  });

  it("logs in with device auth and prints the verification code", async () => {
    const env = await tempEnv();
    const stderr = memoryOutput();

    const profile = await login(
      {
        authFlow: "device",
        network: "mainnet",
        walletUrl: "https://wallet.example",
        walletApiUrl: "https://wallet-api.example",
        relayUrl: "https://relay.example",
        timeoutMs: 1_000,
      },
      {
        authorizeDeviceLogin: async (options) => {
          expect(options.walletUrl).toBe("https://wallet.example");
          expect(options.walletApiUrl).toBe("https://wallet-api.example");
          expect(options.relayUrl).toBe("https://relay.example");
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
        stderr,
      },
    );

    expect(profile.keys).toEqual([]);
    expect(stderr.text).toContain("Running headless?");
    expect(stderr.text).toContain("Code: ABCD-1234");
    expect(stderr.text).toContain(
      "Direct link: https://wallet.example/cli-auth?code=ABCD-1234",
    );
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      accountAddress: "0x1111111111111111111111111111111111111111",
      walletApiUrl: "https://wallet-api.example",
      keys: [],
    });
  });

  it("uses --config-dir ahead of the dependency environment", async () => {
    const env = await tempEnv();
    const overrideEnv = await tempEnv();
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      openBrowser: async (url) => {
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirectUri");
        expect(redirectUri).not.toBeNull();
        const callbackUrl = new URL(redirectUri!);
        callbackUrl.searchParams.set(
          "state",
          authUrl.searchParams.get("state")!,
        );
        callbackUrl.searchParams.set("status", "approved");
        callbackUrl.searchParams.set(
          "accountAddress",
          "0x1111111111111111111111111111111111111111",
        );
        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);
      },
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--config-dir",
      overrideEnv.MEGA_WALLET_CLI_CONFIG_DIR!,
      "--wallet-url",
      "https://wallet.example",
      "--json",
    ]);

    await expect(profileExists("mainnet", env)).resolves.toBe(false);
    await expect(
      readWalletProfile("mainnet", overrideEnv),
    ).resolves.toMatchObject({
      accountAddress: "0x1111111111111111111111111111111111111111",
      keys: [],
    });
  });

  it("prints a headed login intro without exposing the auth URL", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput({ columns: 80, isTTY: true });
    const opened: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      openBrowser: async (url) => {
        opened.push(url);
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirectUri");
        expect(redirectUri).not.toBeNull();
        const callbackUrl = new URL(redirectUri!);
        callbackUrl.searchParams.set(
          "state",
          authUrl.searchParams.get("state")!,
        );
        callbackUrl.searchParams.set("status", "approved");
        callbackUrl.searchParams.set(
          "accountAddress",
          "0x1111111111111111111111111111111111111111",
        );
        const response = await fetch(callbackUrl);
        expect(response.status).toBe(200);
      },
      stderr,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
    ]);

    expect(opened).toHaveLength(1);
    expect(stderr.text).toContain("\x1b[");
    expect(stderr.text).toContain("Opening MegaETH Wallet...");
    expect(stripAnsi(stderr.text)).not.toContain("Open this URL to authorize:");
    expect(stripAnsi(stderr.text)).not.toContain("Browser didn't open?");
    expect(stripAnsi(stderr.text)).toContain("boot system initialized");
    expect(stripAnsi(stderr.text)).toContain("__  __");
    expect(stripAnsi(stderr.text)).not.toContain("[ok] MOSS wallet connected");
    expect(stderr.text).not.toContain(opened[0]);
    expect(stdout.text).toContain("[ok] MOSS wallet connected");
    expect(stdout.text).toContain("Network: mainnet");
  });

  it("falls back to a printed auth URL when the browser cannot be opened", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput({ columns: 80, isTTY: true });
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      openBrowser: async (url) => {
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirectUri");
        expect(redirectUri).not.toBeNull();
        setTimeout(async () => {
          const callbackUrl = new URL(redirectUri!);
          callbackUrl.searchParams.set(
            "state",
            authUrl.searchParams.get("state")!,
          );
          callbackUrl.searchParams.set("status", "approved");
          callbackUrl.searchParams.set(
            "accountAddress",
            "0x1111111111111111111111111111111111111111",
          );
          await fetch(callbackUrl);
        }, 20);
        return false;
      },
      stderr,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
    ]);

    const plainStderr = stripAnsi(stderr.text);
    expect(plainStderr).toContain("⚠️ Could not open a browser automatically.");
    expect(plainStderr).toContain("Open this URL in your browser to continue:");
    expect(plainStderr).toContain("Waiting for approval...");
    expect(
      plainStderr.match(/Open this URL in your browser to continue:/g),
    ).toHaveLength(1);
    expect(stdout.text).toContain("[ok] MOSS wallet connected");
  });

  it("prints a fallback auth URL after a delay while waiting for approval", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput({ columns: 80, isTTY: true });
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      browserFallbackDelayMs: 10,
      env,
      now: () => activeNow,
      openBrowser: async (url) => {
        const authUrl = new URL(url);
        const redirectUri = authUrl.searchParams.get("redirectUri");
        expect(redirectUri).not.toBeNull();
        setTimeout(async () => {
          const callbackUrl = new URL(redirectUri!);
          callbackUrl.searchParams.set(
            "state",
            authUrl.searchParams.get("state")!,
          );
          callbackUrl.searchParams.set("status", "approved");
          callbackUrl.searchParams.set(
            "accountAddress",
            "0x1111111111111111111111111111111111111111",
          );
          await fetch(callbackUrl);
        }, 30);
        return true;
      },
      stderr,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
    ]);

    const plainStderr = stripAnsi(stderr.text);
    expect(plainStderr).toContain("Browser didn't open?");
    expect(plainStderr).toContain("Open this URL in your browser to continue:");
    expect(plainStderr).toContain("Waiting for approval...");
    expect(
      plainStderr.match(/Open this URL in your browser to continue:/g),
    ).toHaveLength(1);
    expect(stdout.text).toContain("[ok] MOSS wallet connected");
  });

  it("prints the login intro and auth URL in no-browser mode", async () => {
    const env = await tempEnv();
    const stdout = memoryOutput();
    const stderr = memoryOutput({ columns: 80, isTTY: true });
    const program = new Command();
    program.exitOverride();
    registerWalletCommands(program, {
      env,
      now: () => activeNow,
      openBrowser: async () => {
        throw new Error("openBrowser should not be called");
      },
      stderr,
      stdout,
    });

    const pending = program.parseAsync([
      "node",
      "mega",
      "moss",
      "login",
      "--wallet-url",
      "https://wallet.example",
      "--wallet-api-url",
      "https://wallet-api.example",
      "--relay-url",
      "https://relay.example",
      "--timeout-ms",
      "5000",
      "--no-browser",
    ]);

    await waitForOutput(stderr, "Open this URL to authorize:");
    const plainStderr = stripAnsi(stderr.text);
    expect(plainStderr).toContain("boot system initialized");
    expect(plainStderr).toContain("__  __");
    expect(plainStderr).not.toContain("Opening MegaETH Wallet...");
    expect(plainStderr).toContain("Open this URL to authorize:");

    const match = plainStderr.match(
      /Open this URL to authorize: (https?:\/\/\S+)/,
    );
    expect(match?.[1]).toBeDefined();
    const authUrl = new URL(match![1]!);
    const redirectUri = authUrl.searchParams.get("redirectUri");
    expect(redirectUri).not.toBeNull();
    const callbackUrl = new URL(redirectUri!);
    callbackUrl.searchParams.set("state", authUrl.searchParams.get("state")!);
    callbackUrl.searchParams.set("status", "approved");
    callbackUrl.searchParams.set(
      "accountAddress",
      "0x1111111111111111111111111111111111111111",
    );
    const response = await fetch(callbackUrl);
    expect(response.status).toBe(200);

    await pending;

    expect(stdout.text).toContain("[ok] MOSS wallet connected");
    expect(stdout.text).toContain("Network: mainnet");
  });

  it("creates a key with device auth and prints the verification code", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const created = makeKey({
      id: "0x8888888888888888888888888888888888888888",
      accessAddress: "0x8888888888888888888888888888888888888888",
      privateKey:
        "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    const stderr = memoryOutput();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletCreateKey(
      {
        allowCall: [
          "0x4444444444444444444444444444444444444444:transfer(address,uint256)",
        ],
        authFlow: "device",
        network: "mainnet",
        timeoutMs: 1_000,
        terse: true,
      },
      {
        authorizeDeviceKey: async (options) => {
          expect(options.walletUrl).toBe(profile.walletUrl);
          expect(options.walletApiUrl).toBe(profile.walletApiUrl);
          expect(options.existingAccountAddress).toBe(profile.accountAddress);
          options.onPrompt?.({
            verificationUri: "https://wallet.example/cli-auth",
            verificationUriComplete:
              "https://wallet.example/cli-auth?code=ABCD-1234",
            userCode: "ABCD-1234",
            expiresAt: "2026-05-07T00:10:00.000Z",
          });
          return {
            accountAddress: profile.accountAddress,
            authUrl: "https://wallet.example/cli-auth?code=ABCD-1234",
            key: created,
            relayUrl: profile.relayUrl,
            walletUrl: profile.walletUrl,
          };
        },
        authorizeKey: async () => {
          throw new Error("authorizeKey should not be called");
        },
        env,
        now: () => activeNow,
        stderr,
        stdout,
      },
    );

    expect(result.key.id).toBe(created.id);
    expect(stderr.text).toContain("Code: ABCD-1234");
    expect(stdout.text).toBe(
      `mainnet\t${created.id}\t${created.accessAddress}\n`,
    );
    await expect(readWalletProfile("mainnet", env)).resolves.toMatchObject({
      activeKeyId: created.id,
      keys: [{ id: profile.keys[0]!.id }, { id: created.id }],
    });
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
          expect(options.feeToken).toBe("ETH");
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

  it("passes revoke fee-token overrides to wallet authorization", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    await writeWalletProfile(profile, env);

    await runWalletRevoke(
      profile.keys[0]!.id,
      { feeToken: "eth", network: "mainnet", timeoutMs: 1_000 },
      {
        env,
        now: () => activeNow,
        revokeKey: async (options) => {
          expect(options.feeToken).toBe("ETH");
          return {
            authUrl: "https://wallet.example/cli-auth/revoke",
            revokeTxHash:
              "0x9999999999999999999999999999999999999999999999999999999999999999",
          };
        },
        stdout: memoryOutput(),
      },
    );
  });

  it("revokes a key with device auth and prints the verification code", async () => {
    const env = await tempEnv();
    const profile = makeProfile();
    const stderr = memoryOutput();
    const stdout = memoryOutput();
    await writeWalletProfile(profile, env);

    const result = await runWalletRevoke(
      profile.keys[0]!.id,
      {
        authFlow: "device",
        network: "mainnet",
        terse: true,
        timeoutMs: 1_000,
      },
      {
        authorizeDeviceRevoke: async (options) => {
          expect(options.walletApiUrl).toBe(profile.walletApiUrl);
          expect(options.accountAddress).toBe(profile.accountAddress);
          expect(options.accessAddress).toBe(profile.keys[0]!.accessAddress);
          expect(options.feeToken).toBe("ETH");
          options.onPrompt?.({
            verificationUri: "https://wallet.example/cli-auth",
            verificationUriComplete:
              "https://wallet.example/cli-auth?code=ABCD-1234",
            userCode: "ABCD-1234",
            expiresAt: "2026-05-07T00:10:00.000Z",
          });
          return {
            authUrl: "https://wallet.example/cli-auth?code=ABCD-1234",
            revokeTxHash:
              "0x9999999999999999999999999999999999999999999999999999999999999999",
          };
        },
        env,
        now: () => activeNow,
        revokeKey: async () => {
          throw new Error("revokeKey should not be called");
        },
        stderr,
        stdout,
      },
    );

    expect(result.key.effectiveStatus).toBe("revoked");
    expect(stderr.text).toContain("Code: ABCD-1234");
    expect(stdout.text).toBe(
      `mainnet\t${profile.keys[0]!.id}\trevoked\t0x9999999999999999999999999999999999999999999999999999999999999999\n`,
    );
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
      "run mega moss login",
    );
  });

  it("checks for CLI updates without installing", async () => {
    const stdout = memoryOutput();

    const result = await runWalletUpdate(
      { check: true },
      {
        env: {
          MEGA_WALLET_CLI_INSTALLED_VERSION: "v0.1.0",
        },
        stdout,
        update: {
          fetch: async () =>
            new Response(JSON.stringify({ tag_name: "v0.1.1" }), {
              status: 200,
            }),
          runInstaller: async () => {
            throw new Error("runInstaller should not be called");
          },
        },
      },
    );

    expect(result).toMatchObject({
      currentVersion: "v0.1.0",
      latestVersion: "v0.1.1",
      updateAvailable: true,
      updated: false,
    });
    expect(stdout.text).toContain("Update available.");
    expect(stdout.text).toContain("Run: mega moss update");
  });

  it("updates the CLI and keeps installer output off JSON stdout", async () => {
    const stdout = memoryOutput();
    const stderr = memoryOutput();
    const installed: string[] = [];

    await runWalletUpdate(
      { json: true },
      {
        env: {
          MEGA_WALLET_CLI_INSTALLED_VERSION: "v0.1.0",
        },
        stderr,
        stdout,
        update: {
          fetch: async () =>
            new Response(JSON.stringify({ tag_name: "v0.1.1" }), {
              status: 200,
            }),
          runInstaller: async ({ stderr, version }) => {
            installed.push(version);
            stderr?.("installer output\n");
          },
        },
      },
    );

    expect(installed).toEqual(["v0.1.1"]);
    expect(stderr.text).toBe("installer output\n");
    const parsed = JSON.parse(stdout.text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      currentVersion: "v0.1.0",
      latestVersion: "v0.1.1",
      updateAvailable: true,
      updated: true,
    });
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

    await program.parseAsync(["node", "mega", "moss", "whoami", "-t"]);

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

function memoryOutput(options: { columns?: number; isTTY?: boolean } = {}): {
  columns?: number;
  isTTY?: boolean;
  readonly text: string;
  write(chunk: string): void;
} {
  let text = "";

  return {
    ...options,
    get text(): string {
      return text;
    },
    write(chunk: string): void {
      text += chunk;
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function waitForOutput(
  output: { readonly text: string },
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!output.text.includes(expected)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for output: ${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
