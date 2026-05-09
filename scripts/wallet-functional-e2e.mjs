#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeFunctionData, getAddress, isAddress, parseAbi } from "viem";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distCli = resolve(repoRoot, "dist/index.js");
const defaultE2eDir = resolve(repoRoot, ".e2e");
const defaultConfigDir = resolve(defaultE2eDir, "cli-config");
const defaultFixturesDir = resolve(defaultE2eDir, "functional");

const mainnetRpcUrl = "https://mainnet.megaeth.com/rpc";
const recipientAddress = "0x4Da38f00E572ACf11bDd94Dc42Aa882492353029";
const usdmAddress = "0xfafddbb3fc7688494971a79cc65dca3ef82079e7";
const aavePoolAddressesProvider = "0x46Dcd5F4600319b02649Fd76B55aA6c1035CA478";
const aavePool = "0x7e324AbC5De01d112AfC03a584966ff199741C28";
const aaveProtocolDataProvider = "0x9588b453A4EE24a420830CB3302195cA7aA3b403";
const aUsdmAddress = "0x5df82810cb4b8f3e0da3c031ccc9208ee9cf9500";

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const aaveProviderAbi = parseAbi(["function getPool() view returns (address)"]);
const aaveDataProviderAbi = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)",
]);
const aavePoolAbi = parseAbi([
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function withdraw(address asset,uint256 amount,address to) returns (uint256)",
]);

const requiredWriteScopes = [
  `${usdmAddress.toLowerCase()}:transfer(address,uint256)`,
  `${usdmAddress.toLowerCase()}:approve(address,uint256)`,
  `${aavePool.toLowerCase()}:supply(address,uint256,address,uint16)`,
  `${aavePool.toLowerCase()}:withdraw(address,uint256,address)`,
];

const options = parseArgs(process.argv.slice(2));
const results = [];
const notes = [];

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  await assertDistCli();

  let profile;
  let fixtures;
  await test("whoami json exposes active profile metadata", async () => {
    const result = await wallet(["whoami", "--json"]);
    profile = JSON.parse(result.stdout);
    assertEqual(profile.network, "mainnet", "expected mainnet profile");
    assertAddress(profile.accountAddress, "profile accountAddress");
    assertAddress(profile.accessAddress, "profile accessAddress");
    assert(!("privateKey" in profile), "whoami must not print privateKey");
    assert(
      profile.expired === false,
      `profile is expired at ${profile.expiresAt}`,
    );
  });
  fixtures = await writeFixtures(options, profile.accountAddress);

  await test("whoami terse emits stable tab-separated fields", async () => {
    const result = await wallet(["whoami", "-t"]);
    const fields = result.stdout.trim().split("\t");
    assertEqual(fields.length, 5, "expected five terse fields");
    assertEqual(fields[0], "mainnet", "expected mainnet field");
    assertAddress(fields[1], "terse account address");
    assertAddress(fields[2], "terse access address");
    assert(["active", "expired"].includes(fields[3]), "invalid status field");
  });

  await test("keys json lists the active delegated key", async () => {
    const result = await wallet(["keys", "--json"]);
    const keys = JSON.parse(result.stdout);
    assertEqual(keys.network, "mainnet", "expected mainnet keys result");
    assertEqual(keys.keys.length, 1, "expected one local active key");
    assertAddress(keys.keys[0].accessAddress, "key access address");
  });

  await test("debug skip-chain reports local diagnostics", async () => {
    const result = await wallet(["debug", "--skip-chain", "--json"]);
    const debug = JSON.parse(result.stdout);
    assertEqual(debug.network, "mainnet", "expected mainnet debug result");
    assertEqual(debug.accountAddress, profile.accountAddress, "debug account");
    assertEqual(debug.accessAddress, profile.accessAddress, "debug access key");
    assertEqual(
      debug.delegatedKey.chainStatus,
      "skipped",
      "debug chain status",
    );
    assert(!("privateKey" in debug), "debug must not print privateKey");
  });

  await test("fund no-open prints the wallet deposit URL", async () => {
    const result = await wallet(["fund", "--no-open", "--json"]);
    const fund = JSON.parse(result.stdout);
    assertEqual(fund.network, "mainnet", "expected mainnet fund result");
    assertEqual(fund.accountAddress, profile.accountAddress, "fund account");
    assertEqual(fund.opened, false, "fund should not open browser");
    assertIncludes(fund.fundingUrl, "/deposit?");
  });

  await test("logout only removes a copied local profile", async () => {
    await exerciseLogoutWithoutTouchingActiveProfile(options.configDir);
  });

  await test("login rejects unsupported network before browser launch", async () => {
    const result = await wallet(["login", "--network", "testnet"], {
      expectCode: 1,
    });
    assertIncludes(result.stderr, "testnet is not supported yet");
  });

  await test("login validates URL, timeout, and call scope arguments", async () => {
    assertIncludes(
      (
        await wallet(["login", "--wallet-url", "ftp://bad"], {
          expectCode: 1,
        })
      ).stderr,
      "wallet-url must be an HTTP(S) URL",
    );
    assertIncludes(
      (await wallet(["login", "--timeout-ms", "0"], { expectCode: 1 })).stderr,
      "timeout-ms must be a positive integer",
    );
    assertIncludes(
      (await wallet(["login", "--allow-call", "bad"], { expectCode: 1 }))
        .stderr,
      "allow-call must use 0xTarget:signature",
    );
  });

  await test("call raw calldata reads Aave pool address", async () => {
    const result = await wallet([
      "call",
      "--to",
      aavePoolAddressesProvider,
      "--data",
      encodeFunctionData({ abi: aaveProviderAbi, functionName: "getPool" }),
      "--rpc-url",
      options.rpcUrl,
      "--json",
    ]);
    const body = JSON.parse(result.stdout);
    assertEqual(
      decodeAddressResult(body.result),
      getAddress(aavePool),
      "unexpected Aave Pool address",
    );
  });

  await test("call ABI mode reads USDM balance and decimals", async () => {
    const decimals = await wallet([
      "call",
      "--to",
      usdmAddress,
      "--abi",
      fixtures.erc20Abi,
      "--function",
      "decimals",
      "--rpc-url",
      options.rpcUrl,
      "-t",
    ]);
    assertEqual(BigInt(decimals.stdout.trim()), 18n, "USDM decimals mismatch");

    const balance = await wallet([
      "call",
      "--to",
      usdmAddress,
      "--abi",
      fixtures.erc20Abi,
      "--function",
      "balanceOf",
      "--args",
      JSON.stringify([profile.accountAddress]),
      "--rpc-url",
      options.rpcUrl,
      "--json",
    ]);
    const body = JSON.parse(balance.stdout);
    assert(BigInt(body.result) >= 0n, "balance result must be uint256");
  });

  await test("call ABI mode reads Aave reserve tokens", async () => {
    const result = await wallet([
      "call",
      "--to",
      aaveProtocolDataProvider,
      "--abi",
      fixtures.aaveDataProviderAbi,
      "--function",
      "getReserveTokensAddresses",
      "--args",
      JSON.stringify([usdmAddress]),
      "--rpc-url",
      options.rpcUrl,
      "-t",
    ]);
    assertIncludes(result.stdout.toLowerCase(), aUsdmAddress.slice(2, 18));
  });

  await test("call validation errors stay CLI-shaped", async () => {
    assertIncludes(
      (
        await wallet(["call", "--to", aavePoolAddressesProvider], {
          expectCode: 1,
        })
      ).stderr,
      "provide --data or both --abi and --function",
    );
    assertIncludes(
      (
        await wallet(
          ["call", "--to", aavePoolAddressesProvider, "--data", "0x0"],
          { expectCode: 1 },
        )
      ).stderr,
      "call data must be a hex string",
    );
    assertIncludes(
      (
        await wallet(
          [
            "call",
            "--to",
            aavePoolAddressesProvider,
            "--abi",
            fixtures.aaveProviderAbi,
            "--function",
            "nope",
          ],
          { expectCode: 1 },
        )
      ).stderr,
      'Function "nope" not found on ABI',
    );
  });

  await test("execute validation errors stay CLI-shaped", async () => {
    assertIncludes(
      (await wallet(["execute", "--data", "0x"], { expectCode: 1 })).stderr,
      "provide --to or --calls",
    );
    assertIncludes(
      (
        await wallet(
          ["execute", "--to", aavePoolAddressesProvider, "--data", "0x0"],
          { expectCode: 1 },
        )
      ).stderr,
      "execute call data must be a hex string",
    );
    assertIncludes(
      (
        await wallet(
          [
            "execute",
            "--to",
            aavePoolAddressesProvider,
            "--data",
            "0x",
            "--calls",
            fixtures.approveZeroCalls,
          ],
          { expectCode: 1 },
        )
      ).stderr,
      "use either --calls or --to/--data/--value, not both",
    );

    const missingFile = await wallet(
      ["execute", "--calls", resolve(options.fixturesDir, "missing.json")],
      { expectCode: 1 },
    );
    assertIncludes(missingFile.stderr, "ENOENT");
    notes.push("missing --calls file currently surfaces raw ENOENT");
  });

  await test("transfer validation errors stay CLI-shaped", async () => {
    assertIncludes(
      (
        await wallet(
          [
            "transfer",
            "--to",
            "bad",
            "--amount",
            "1",
            "--token",
            usdmAddress,
            "--decimals",
            "18",
          ],
          { expectCode: 1 },
        )
      ).stderr,
      "transfer recipient must be a 20-byte hex address",
    );
    assertIncludes(
      (
        await wallet(
          [
            "transfer",
            "--to",
            options.recipient,
            "--amount",
            "abc",
            "--token",
            usdmAddress,
            "--decimals",
            "18",
          ],
          { expectCode: 1 },
        )
      ).stderr,
      "transfer amount must be a positive decimal amount",
    );
    assertIncludes(
      (
        await wallet(
          [
            "transfer",
            "--to",
            options.recipient,
            "--amount",
            "1",
            "--decimals",
            "18",
          ],
          { expectCode: 1 },
        )
      ).stderr,
      "--decimals can only be used with --token",
    );
  });

  if (!options.writes) {
    notes.push("paid relay write tests skipped; pass --writes to enable them");
  } else {
    await runWriteTests(profile, fixtures);
  }

  if (fixtures) {
    await rm(fixtures.root, { recursive: true, force: true });
  }
  printSummary();
}

async function runWriteTests(profile, fixtures) {
  await test("profile has call scopes required for write regression tests", () => {
    const scopes = new Set(
      profile.authorizedKey.permissions.calls.map(
        (call) => `${call.to.toLowerCase()}:${call.signature}`,
      ),
    );
    const missing = requiredWriteScopes.filter((scope) => !scopes.has(scope));
    assert(
      missing.length === 0,
      [
        "active profile is missing write scopes:",
        ...missing.map((scope) => `  ${scope}`),
        "Re-run loopback login with the required --allow-call flags.",
      ].join("\n"),
    );
  });

  await test("execute rejects an unscoped call with permission error", async () => {
    const result = await wallet(
      [
        "execute",
        "--to",
        aavePoolAddressesProvider,
        "--data",
        encodeFunctionData({ abi: aaveProviderAbi, functionName: "getPool" }),
        "--value",
        "0",
      ],
      { expectCode: 1 },
    );
    assertIncludes(result.stderr, "permission not granted for delegated key");
  });

  await test("execute default output submits scoped approval", async () => {
    const result = await wallet([
      "execute",
      "--calls",
      fixtures.approveZeroCalls,
    ]);
    assertIncludes(result.stdout, "Relay call bundle submitted.");
    assertIncludes(result.stdout, "Status: 200");
  });

  await test("execute bundled Aave approve+supply succeeds", async () => {
    const result = await wallet([
      "execute",
      "--calls",
      fixtures.approveAndSupplyCalls,
      "-t",
    ]);
    assertTerseRelayResult(result.stdout);
  });

  await test("execute single-call Aave withdraw succeeds", async () => {
    const withdrawData = JSON.parse(
      await readFile(fixtures.withdrawCalls, "utf8"),
    )[0].data;
    const result = await wallet([
      "execute",
      "--to",
      aavePool,
      "--data",
      withdrawData,
      "--value",
      "0",
      "-t",
    ]);
    assertTerseRelayResult(result.stdout);
  });

  await test("transfer ERC20 succeeds through relay", async () => {
    const result = await wallet([
      "transfer",
      "--to",
      options.recipient,
      "--amount",
      options.amount,
      "--token",
      usdmAddress,
      "--rpc-url",
      options.rpcUrl,
      "-t",
    ]);
    assertTerseRelayResult(result.stdout);
  });

  await test("native transfer without call scope is rejected", async () => {
    const result = await wallet(
      [
        "transfer",
        "--to",
        options.recipient,
        "--amount",
        "0.000000000000000001",
        "-t",
      ],
      { expectCode: 1 },
    );
    assertIncludes(result.stderr, "permission not granted for delegated key");
  });

  if (options.includeTimeout) {
    await test("execute timeout is surfaced as terminal CLI error", async () => {
      const result = await wallet(
        [
          "execute",
          "--calls",
          fixtures.approveZeroCalls,
          "--timeout-ms",
          "1",
          "--poll-interval-ms",
          "1",
        ],
        { expectCode: 1 },
      );
      assertIncludes(result.stderr, "relay call bundle timed out after 1ms");
    });
  } else {
    notes.push(
      "timeout write test skipped; pass --include-timeout to enable it",
    );
  }
}

async function writeFixtures(parsed, accountAddress) {
  const root = resolve(parsed.fixturesDir, `${Date.now()}`);
  const abiDir = resolve(root, "abi");
  const callsDir = resolve(root, "calls");
  await mkdir(abiDir, { recursive: true });
  await mkdir(callsDir, { recursive: true });

  const erc20AbiPath = resolve(abiDir, "erc20.json");
  const aaveProviderAbiPath = resolve(abiDir, "aave-provider.json");
  const aaveDataProviderAbiPath = resolve(abiDir, "aave-data-provider.json");
  await writeJson(erc20AbiPath, erc20Abi);
  await writeJson(aaveProviderAbiPath, aaveProviderAbi);
  await writeJson(aaveDataProviderAbiPath, aaveDataProviderAbi);

  const amountUnits = parseUnits(parsed.amount, 18);
  const approveAmountData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [aavePool, amountUnits],
  });
  const approveZeroData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [aavePool, 0n],
  });
  const supplyData = encodeFunctionData({
    abi: aavePoolAbi,
    functionName: "supply",
    args: [usdmAddress, amountUnits, accountAddress, 0],
  });
  const withdrawData = encodeFunctionData({
    abi: aavePoolAbi,
    functionName: "withdraw",
    args: [usdmAddress, amountUnits, accountAddress],
  });

  const approveZeroCalls = resolve(callsDir, "usdm-approve-aave-zero.json");
  const approveAndSupplyCalls = resolve(
    callsDir,
    "aave-approve-and-supply-usdm.json",
  );
  const withdrawCalls = resolve(callsDir, "aave-withdraw-usdm.json");

  await writeJson(approveZeroCalls, [
    {
      to: usdmAddress,
      data: approveZeroData,
      value: "0",
    },
  ]);
  await writeJson(approveAndSupplyCalls, [
    {
      to: usdmAddress,
      data: approveAmountData,
      value: "0",
    },
    {
      to: aavePool,
      data: supplyData,
      value: "0",
    },
  ]);
  await writeJson(withdrawCalls, [
    {
      to: aavePool,
      data: withdrawData,
      value: "0",
    },
  ]);

  return {
    root,
    erc20Abi: erc20AbiPath,
    aaveProviderAbi: aaveProviderAbiPath,
    aaveDataProviderAbi: aaveDataProviderAbiPath,
    approveZeroCalls,
    approveAndSupplyCalls,
    withdrawCalls,
  };
}

async function exerciseLogoutWithoutTouchingActiveProfile(configDir) {
  const sourceProfile = resolve(
    configDir,
    "profiles",
    "mainnet",
    "default.json",
  );
  const tempConfig = await mkdtempSafe("mega-wallet-functional-");
  const targetProfile = resolve(
    tempConfig,
    "profiles",
    "mainnet",
    "default.json",
  );
  await mkdir(dirname(targetProfile), { recursive: true });
  await copyFile(sourceProfile, targetProfile);

  const env = configEnv(tempConfig);
  const logout = await wallet(["logout"], { env });
  assertIncludes(logout.stdout, "Removed mainnet wallet profile.");
  const missing = await wallet(["whoami"], { env, expectCode: 1 });
  assertIncludes(missing.stderr, "no mainnet wallet profile found");
  await rm(tempConfig, { recursive: true, force: true });
}

async function wallet(args, runOptions = {}) {
  const env = runOptions.env ?? configEnv(options.configDir);
  return run([process.execPath, distCli, "wallet", ...args], {
    env,
    expectCode: runOptions.expectCode ?? 0,
  });
}

async function run(argv, runOptions) {
  const [command, ...args] = argv;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...runOptions.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const [stdout, stderr, code] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on("close", resolve)),
  ]);

  if (code !== runOptions.expectCode) {
    throw new Error(
      [
        `Command failed with code ${code}; expected ${runOptions.expectCode}`,
        `$ ${argv.map(shellQuote).join(" ")}`,
        stdout ? `stdout:\n${stdout}` : undefined,
        stderr ? `stderr:\n${stderr}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return { code, stdout, stderr };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - started;
    results.push({ durationMs, name, status: "pass" });
    console.log(`PASS ${name} (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - started;
    results.push({ durationMs, error, name, status: "fail" });
    console.error(`FAIL ${name} (${durationMs}ms)`);
    throw error;
  }
}

function configEnv(configDir) {
  return { MEGA_WALLET_CLI_CONFIG_DIR: configDir };
}

async function assertDistCli() {
  try {
    await readFile(distCli);
  } catch {
    throw new Error("dist/index.js not found; run npm run build first");
  }
}

function parseArgs(args) {
  const parsed = {
    amount: "0.00001",
    configDir: defaultConfigDir,
    fixturesDir: defaultFixturesDir,
    includeTimeout: false,
    recipient: recipientAddress,
    rpcUrl: mainnetRpcUrl,
    writes: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--amount":
        parsed.amount = readValue(args, ++index, arg);
        break;
      case "--config-dir":
        parsed.configDir = resolve(readValue(args, ++index, arg));
        break;
      case "--fixtures-dir":
        parsed.fixturesDir = resolve(readValue(args, ++index, arg));
        break;
      case "--include-timeout":
        parsed.includeTimeout = true;
        break;
      case "--recipient":
        parsed.recipient = readValue(args, ++index, arg);
        break;
      case "--rpc-url":
        parsed.rpcUrl = readValue(args, ++index, arg);
        break;
      case "--writes":
        parsed.writes = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  assertAddress(parsed.recipient, "recipient");
  parseUnits(parsed.amount, 18);
  return parsed;
}

function printHelp() {
  console.log(`Usage: npm run e2e:functional -- [options]

Runs wallet CLI regression checks against the current local profile.

Options:
  --writes              Run paid relay write tests
  --include-timeout     Include the paid timeout lifecycle test
  --config-dir <path>   CLI config dir (default: .e2e/cli-config)
  --fixtures-dir <path> Generated fixture dir (default: .e2e/functional)
  --recipient <address> ERC20 transfer recipient
  --amount <amount>     USDM amount for paid tests (default: 0.00001)
  --rpc-url <url>       MegaETH RPC URL (default: ${mainnetRpcUrl})`);
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseUnits(value, decimals) {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`amount must be a positive decimal amount: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`amount has more than ${decimals} decimals: ${value}`);
  }
  const units = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (units <= 0n) {
    throw new Error(`amount must be greater than zero: ${value}`);
  }
  return units;
}

function assertTerseRelayResult(value) {
  const fields = value.trim().split("\t");
  assertEqual(fields.length, 3, "expected three terse relay fields");
  assertHex(fields[0], "bundle id");
  assertEqual(fields[1], "200", "expected relay status 200");
  assertHex(fields[2], "transaction hash");
}

function decodeAddressResult(value) {
  assertHex(value, "address result");
  return getAddress(`0x${value.slice(-40)}`);
}

function assertAddress(value, label) {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`${label} must be a 20-byte address`);
  }
}

function assertHex(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} must be hex`);
  }
}

function assertIncludes(value, expected) {
  assert(
    value.includes(expected),
    `expected output to include ${JSON.stringify(expected)}\nActual:\n${value}`,
  );
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function writeJson(path, value) {
  await writeFile(
    path,
    `${JSON.stringify(
      value,
      (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
      2,
    )}\n`,
  );
}

async function mkdtempSafe(prefix) {
  await mkdir(resolve(defaultE2eDir), { recursive: true });
  return mkdtemp(resolve(tmpdir(), prefix));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printSummary() {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.length - passed;
  console.log(`\nWallet functional E2E: ${passed} passed, ${failed} failed`);
  if (notes.length > 0) {
    console.log("\nNotes:");
    for (const note of notes) {
      console.log(`- ${note}`);
    }
  }
}
