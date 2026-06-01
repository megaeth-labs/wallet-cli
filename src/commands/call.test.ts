import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCallCommand, runWalletCall } from "./call.js";
import {
  fromViemPublicClient,
  type ViemPublicCallClient,
} from "../eth/client.js";

const tempDirs: string[] = [];
const target = "0x1234567890abcdef1234567890abcdef12345678";
const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const rpcUrl = "https://rpc.example";

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("wallet call", () => {
  it("runs raw calldata without reading a wallet profile", async () => {
    const env = await tempEnv();
    const client = {
      call: vi.fn().mockResolvedValue("0x1234"),
    };
    const stdout = memoryOutput();

    const result = await runWalletCall(
      {
        data: "0x70a08231",
        json: true,
        network: "mainnet",
        rpcUrl,
        to: target,
      },
      {
        createClient: () => client,
        env,
        stdout,
      },
    );

    expect(client.call).toHaveBeenCalledWith({
      data: "0x70a08231",
      to: target,
    });
    expect(result.result).toBe("0x1234");
    expect(JSON.parse(stdout.text)).toEqual({
      data: "0x70a08231",
      network: "mainnet",
      result: "0x1234",
      rpcUrl: `${rpcUrl}/`,
      to: target,
    });
  });

  it("runs testnet raw calldata when no testnet profile exists", async () => {
    const env = await tempEnv();
    const client = {
      call: vi.fn().mockResolvedValue("0x1234"),
    };
    const stdout = memoryOutput();

    const result = await runWalletCall(
      {
        data: "0x70a08231",
        network: "testnet",
        rpcUrl,
        terse: true,
        to: target,
      },
      {
        createClient: () => client,
        env,
        stdout,
      },
    );

    expect(client.call).toHaveBeenCalledWith({
      data: "0x70a08231",
      to: target,
    });
    expect(result.network).toBe("testnet");
    expect(stdout.text).toBe("0x1234\n");
  });

  it("formats default output with consistent field labels", async () => {
    const env = await tempEnv();
    const client = {
      call: vi.fn().mockResolvedValue("0x1234"),
    };
    const stdout = memoryOutput();

    await runWalletCall(
      {
        data: "0x70a08231",
        network: "mainnet",
        rpcUrl,
        to: target,
      },
      {
        createClient: () => client,
        env,
        stdout,
      },
    );

    expect(stdout.text).toContain("Result: 0x1234");
    expect(stdout.text).toContain("Network: mainnet");
    expect(stdout.text).toContain(`RPC URL: ${rpcUrl}/`);
    expect(stdout.text).toContain(`To: ${target}`);
  });

  it("encodes ABI function calls before eth_call", async () => {
    const env = await tempEnv();
    const abiPath = await writeTempAbi([
      {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ name: "balance", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
    ]);
    const client = {
      call: vi.fn().mockResolvedValue("0x00"),
    };
    const stdout = memoryOutput();

    await runWalletCall(
      {
        abi: abiPath,
        args: JSON.stringify([account]),
        function: "balanceOf",
        network: "mainnet",
        rpcUrl,
        terse: true,
        to: target,
      },
      {
        createClient: () => client,
        env,
        stdout,
      },
    );

    expect(client.call).toHaveBeenCalledWith({
      data: `0x70a08231000000000000000000000000${account.slice(2)}`,
      to: target,
    });
    expect(stdout.text).toBe("0x00\n");
  });

  it("rejects invalid ABI args before calling RPC", async () => {
    const abiPath = await writeTempAbi([]);
    const client = {
      call: vi.fn().mockResolvedValue("0x00"),
    };

    await expect(
      runWalletCall(
        {
          abi: abiPath,
          args: '{"account":"0x1"}',
          function: "balanceOf",
          network: "mainnet",
          rpcUrl,
          to: target,
        },
        { createClient: () => client, stdout: memoryOutput() },
      ),
    ).rejects.toThrow("ABI args must be a JSON array");
    expect(client.call).not.toHaveBeenCalled();
  });

  it("rejects invalid raw call input", async () => {
    await expect(
      runWalletCall(
        {
          data: "0x123",
          network: "mainnet",
          rpcUrl,
          to: target,
        },
        {
          createClient: () => ({ call: vi.fn().mockResolvedValue("0x00") }),
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow("call data must be a hex string");
  });

  it("maps RPC failures without echoing raw calldata", async () => {
    const data = `0x${"aa".repeat(64)}`;

    await expect(
      runWalletCall(
        {
          data,
          network: "mainnet",
          rpcUrl,
          to: target,
        },
        {
          createClient: () => ({
            call: async () => {
              throw new Error(`HTTP request failed.\nRequest body: ${data}`);
            },
          }),
          stdout: memoryOutput(),
        },
      ),
    ).rejects.toThrow("eth_call failed: HTTP request failed.");
  });

  it("adapts a viem public client call result", async () => {
    const publicClient: ViemPublicCallClient = {
      call: async () => ({ data: "0xabcd" }),
    };
    const client = fromViemPublicClient(publicClient);

    await expect(client.call({ data: "0x", to: target })).resolves.toBe(
      "0xabcd",
    );
  });

  it("registers the reachable wallet call command", async () => {
    const client = {
      call: vi.fn().mockResolvedValue("0x99"),
    };
    const stdout = memoryOutput();
    const program = new Command();
    program.exitOverride();
    const wallet = program.command("wallet");
    registerCallCommand(wallet, {
      createClient: () => client,
      stdout,
    });

    await program.parseAsync([
      "node",
      "mega",
      "wallet",
      "call",
      "--to",
      target,
      "--data",
      "0x",
      "--rpc-url",
      rpcUrl,
      "-t",
    ]);

    expect(stdout.text).toBe("0x99\n");
  });
});

async function writeTempAbi(abi: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-call-"));
  tempDirs.push(dir);
  const path = join(dir, "abi.json");
  await writeFile(path, `${JSON.stringify(abi)}\n`, "utf8");

  return path;
}

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "mega-wallet-call-"));
  tempDirs.push(dir);

  return { MEGA_WALLET_CLI_CONFIG_DIR: dir };
}

function memoryOutput(): { text: string; write(chunk: string): void } {
  return {
    text: "",
    write(chunk: string): void {
      this.text += chunk;
    },
  };
}
