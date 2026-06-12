import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executePlannedCalls } from "./execute-execute.js";
import { writeWalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("execute planned calls", () => {
  it("executes normalized calls through executeWalletCalls", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);
    const executor = vi.fn(async () => ({
      accessAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x1111111111111111111111111111111111111111",
      id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      network: "mainnet" as const,
      receipts: [],
      relayUrl: "https://relay.example",
      status: 200,
    }));

    const result = await executePlannedCalls(
      {
        network: "mainnet",
        calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0" }],
      },
      { env, executeWalletCalls: executor },
    );

    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.previewWarnings).toEqual([]);
  });

  it("refuses execution when readiness is not ready", async () => {
    const env = await tempEnv();
    await writeWalletProfile({ ...makeProfile(), activeKeyId: undefined, keys: [] }, env);
    const executor = vi.fn();

    await expect(
      executePlannedCalls(
        {
          network: "mainnet",
          calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0" }],
        },
        { env, executeWalletCalls: executor as never },
      ),
    ).rejects.toThrow("No delegated keys exist yet");
    expect(executor).not.toHaveBeenCalled();
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "wallet-cli-execute-execute-"));
  tempDirs.push(root);
  return { ...process.env, XDG_CONFIG_HOME: root };
}

function makeProfile() {
  return {
    version: 1 as const,
    accountAddress: "0x1111111111111111111111111111111111111111" as const,
    activeKeyId: "0x3333333333333333333333333333333333333333333333333333333333333333" as const,
    keys: [
      {
        accessAddress: "0x2222222222222222222222222222222222222222" as const,
        authorizedKey: {
          type: "secp256k1",
          role: "session",
          publicKey: "0x2222222222222222222222222222222222222222",
          expiry: 1_900_000_000,
          feeToken: { symbol: "ETH", limit: "1000000000000000" },
          permissions: { calls: [], spend: [] },
        },
        createdAt: "2026-05-07T00:00:00.000Z",
        id: "0x3333333333333333333333333333333333333333333333333333333333333333" as const,
        privateKey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
        status: "active" as const,
        updatedAt: "2026-05-07T00:00:00.000Z",
      },
    ],
    network: "mainnet" as const,
    relayUrl: "https://relay.example",
    updatedAt: "2026-05-07T00:00:00.000Z",
    walletApiUrl: "https://wallet-api.example",
    walletUrl: "https://wallet.example",
    createdAt: "2026-05-07T00:00:00.000Z",
  };
}
