import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { previewTransfer } from "./transfer-preview.js";
import { writeWalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("transfer preview capability diagnostics", () => {
  it("returns needs_key guidance when no delegated keys exist", async () => {
    const env = await tempEnv();
    await writeWalletProfile(
      {
        ...makeProfile(),
        activeKeyId: undefined,
        keys: [],
      },
      env,
    );

    const result = await previewTransfer(
      { amount: "1", to: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      { env },
    );

    expect(result.readiness).toBe("needs_key");
    expect(result.issues[0]?.code).toBe("no_keys");
    expect(result.issues[0]?.suggestedAction).toContain("mega moss create-key");
  });

  it("returns ready when a usable delegated key exists", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);

    const result = await previewTransfer(
      { amount: "1", to: "0x1111111111111111111111111111111111111111", network: "mainnet" },
      { env },
    );

    expect(result.readiness).toBe("ready");
    expect(result.issues).toEqual([]);
    expect(result.activeKey?.accessAddress).toBe(
      "0x2222222222222222222222222222222222222222",
    );
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "wallet-cli-transfer-preview-"));
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
    createdAt: "2026-05-07T00:00:00.000Z",
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
  };
}
