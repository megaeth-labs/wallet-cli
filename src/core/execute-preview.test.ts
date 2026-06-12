import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { previewExecute } from "./execute-preview.js";
import { writeWalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("execute preview", () => {
  it("surfaces permission deltas for missing execute authority", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);
    const result = await previewExecute(
      {
        network: "mainnet",
        calls: [{ to: "0x9999999999999999999999999999999999999999", data: "0xa9059cbb", value: "10" }],
      },
      { env },
    );

    expect(result.readiness).toBe("needs_key");
    expect(result.issues.map((issue) => issue.code)).toContain("missing_call_permission");
    expect(result.issues.map((issue) => issue.code)).toContain("missing_spend_permission");
    expect(result.issues.find((issue) => issue.code === "missing_call_permission")?.delta?.missingCalls?.[0]).toEqual({
      to: "0x9999999999999999999999999999999999999999",
      signature: "selector:0xa9059cbb",
    });
  });

  it("normalizes calls and reports readiness", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);
    const result = await previewExecute(
      {
        network: "mainnet",
        calls: [{ to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0" }],
      },
      { env },
    );

    expect(result.readiness).toBe("ready");
    expect(result.calls).toEqual([
      { to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0" },
    ]);
  });
});

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "wallet-cli-execute-preview-"));
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
          permissions: { calls: [{ to: "0x1111111111111111111111111111111111111111", signature: "selector:0x" }], spend: [] },
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
