import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeTransfer } from "./transfer-execute.js";
import { writeWalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("transfer execute", () => {
  it("executes through executeWalletCalls using the planned transfer call", async () => {
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
      transactionHash:
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const,
    }));

    const result = await executeTransfer(
      { amount: "1", to: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      { env, executeWalletCalls: executor },
    );

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]?.[0]).toMatchObject({
      network: "mainnet",
      calls: [
        {
          to: "0x1111111111111111111111111111111111111111",
          data: "0x",
          value: "1000000000000000000",
        },
      ],
    });
    expect(result.transfer.asset).toBe("native");
    expect(result.previewWarnings).toEqual([]);
  });

  it("refuses execution when preview readiness is not ready", async () => {
    const env = await tempEnv();
    await writeWalletProfile({ ...makeProfile(), activeKeyId: undefined, keys: [] }, env);
    const executor = vi.fn(async () => ({
      accessAddress: "0x2222222222222222222222222222222222222222",
      accountAddress: "0x1111111111111111111111111111111111111111",
      id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      network: "mainnet" as const,
      receipts: [],
      relayUrl: "https://relay.example",
      status: 200,
    }));

    await expect(
      executeTransfer(
        { amount: "1", to: "0x1111111111111111111111111111111111111111", network: "mainnet" },
        { env, executeWalletCalls: executor },
      ),
    ).rejects.toThrow("No delegated keys exist yet");
    expect(executor).not.toHaveBeenCalled();
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "wallet-cli-transfer-execute-"));
  tempDirs.push(root);
  return {
    ...process.env,
    XDG_CONFIG_HOME: root,
  };
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
          permissions: {
            calls: [],
            spend: [],
          },
        },
        createdAt: "2026-05-07T00:00:00.000Z",
        id: "0x3333333333333333333333333333333333333333333333333333333333333333" as const,
        privateKey:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
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
