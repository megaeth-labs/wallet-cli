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
  it("rejects non-JSON-RPC requests", async () => {
    const { responses } = await runSession(['{"method":"tools/list"}']);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "invalid_request" },
    });
  });

  it("supports MCP JSON-RPC initialize, tools/list, and tools/call", async () => {
    const env = await tempEnv();
    await writeWalletProfile({ ...makeProfile(), activeKeyId: undefined, keys: [] }, env);
    const { responses } = await runSession([
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"moss_wallet_status","arguments":{"network":"mainnet"}}}',
    ], env);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mega-moss-mcp", version: "0.1.0" },
      },
    });
    const tools = responses[1]?.result?.tools as Array<{ name: string; annotations?: { metadata?: { role?: string }; readOnlyHint?: boolean; destructiveHint?: boolean } }>;
    expect(tools.some((tool) => tool.name === "moss_wallet_status")).toBe(true);
    expect(tools.find((tool) => tool.name === "moss_execute")?.annotations?.metadata?.role).toBe("execute");
    expect(tools.find((tool) => tool.name === "moss_wallet_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "moss_execute")?.annotations?.destructiveHint).toBe(true);
    expect(responses[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        isError: false,
        structuredContent: {
          network: "mainnet",
          readiness: "needs_key",
        },
      },
    });
  });

  it("supports ping and returns JSON-RPC errors for unknown tools", async () => {
    const { responses } = await runSession([
      '{"jsonrpc":"2.0","id":10,"method":"ping","params":{}}',
      '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"missing_tool","arguments":{}}}',
    ]);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 10,
      result: {},
    });
    expect(responses[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 11,
      error: { code: -32601, message: "unknown_tool" },
    });
  });

  it("returns structured MCP tool errors", async () => {
    const { responses } = await runSession([
      '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"moss_permissions","arguments":{"network":"mainnet"}}}',
    ]);
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 12,
      result: {
        isError: true,
        structuredContent: { error: "key is required" },
      },
    });
  });

  it("returns structured refusal for transfer_execute without delegated readiness", async () => {
    const env = await tempEnv();
    await writeWalletProfile({ ...makeProfile(), activeKeyId: undefined, keys: [] }, env);
    const { responses } = await runSession(
      [
        '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"moss_transfer_execute","arguments":{"network":"mainnet","to":"0x1111111111111111111111111111111111111111","amount":"1"}}}',
      ],
      env,
    );
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 20,
      result: {
        isError: true,
        structuredContent: { error: "No delegated keys exist yet." },
      },
    });
  });

  it("serves wallet_status for a configured profile", async () => {
    const env = await tempEnv();
    await writeWalletProfile(makeProfile(), env);
    const { responses } = await runSession(
      ['{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"moss_wallet_status","arguments":{"network":"mainnet"}}}'],
      env,
    );
    expect(responses[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 21,
      result: {
        structuredContent: {
          network: "mainnet",
          readiness: "ready",
          keyCount: 1,
        },
      },
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
