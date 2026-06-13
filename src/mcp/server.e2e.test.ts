import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runMcpServer } from "./server.js";
import { writeWalletProfile } from "../config/profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MCP server end-to-end", () => {
  it("lists tools over the stream protocol", async () => {
    const { responses } = await runSession(['{"tool":"mcp.tools"}']);
    expect(responses[0]?.tools).toBeDefined();
    const tools = responses[0]?.tools as Array<{ name: string; metadata?: { pairsWith?: string; role?: string } }>;
    expect(tools.some((tool) => tool.name === "moss_execute")).toBe(true);
    expect(tools.find((tool) => tool.name === "moss_transfer_preview")?.metadata?.pairsWith).toBe("moss_transfer_execute");
    expect(tools.find((tool) => tool.name === "moss_execute")?.metadata?.role).toBe("execute");
  });

  it("returns structured refusal for transfer_execute without delegated readiness", async () => {
    const env = await tempEnv();
    await writeWalletProfile({ ...makeProfile(), activeKeyId: undefined, keys: [] }, env);
    const { responses } = await runSession(
      [
        '{"tool":"moss_transfer_execute","input":{"network":"mainnet","to":"0x1111111111111111111111111111111111111111","amount":"1"}}',
      ],
      env,
    );
    expect(responses[0]?.error).toContain("No delegated keys exist yet");
  });

  it("serves wallet_status for a configured profile", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);
    const { responses } = await runSession(
      ['{"tool":"moss_wallet_status","input":{"network":"mainnet"}}'],
      env,
    );
    expect(responses[0]?.result).toMatchObject({
      network: "mainnet",
      readiness: "ready",
      keyCount: 1,
    });
  });
});

async function runSession(lines: string[], env?: NodeJS.ProcessEnv) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  const previousEnv = process.env;
  if (env) process.env = env;
  const run = runMcpServer({ input, output });
  for (const line of lines) input.write(line + "\n");
  input.end();
  await run;
  process.env = previousEnv;
  return { responses: chunks.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "wallet-cli-mcp-e2e-"));
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
          expiry: 2_500_000_000,
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
