#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultE2eDir = resolve(repoRoot, ".e2e");
const chainConfigs = {
  mainnet: {
    chainIdHex: "0x10e6",
    usdmAddress: "0xfafddbb3fc7688494971a79cc65dca3ef82079e7",
    usdt0Address: "0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb",
  },
  testnet: {
    chainIdHex: "0x18c7",
    usdmAddress: "0x15e9f2b0a747ac05c7446559306687085d161e5c",
    usdt0Address: "0xd7617e72202b060ff8f315177748b52c7163a010",
  },
};
const nativeTokenAddress = "native";
const defaultRelayUrl = "https://wallet-relay.megaeth.com";
const anyCallTarget = "0x3232323232323232323232323232323232323232";
const anyCallSelector = "0x32323232";
const deviceUserCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

class ScreenOnlyComplete extends Error {
  constructor() {
    super("screen-only-complete");
  }
}

const options = parseArgs(process.argv.slice(2));

if (options.reset) {
  await rm(options.e2eDir, { recursive: true, force: true });
}
await mkdir(options.e2eDir, { recursive: true });

const shim = await startShimBackend({
  mockRelay: options.mockRelay,
  network: options.network,
  port: options.shimPort,
  statePath: resolve(options.e2eDir, "shim-state.json"),
  relayUrl: options.relayUrl,
  walletUrl: options.walletUrl,
});

if (options.shimOnly) {
  console.log("Loopback E2E shim ready. Press Ctrl+C to exit.");
  await new Promise(() => {});
}

let browser;
let page;
const telemetry = createTelemetry();
try {
  await waitForWalletUi(options.walletUrl, options.timeoutMs);

  browser = await chromium.launchPersistentContext(options.profileDir, {
    headless: !options.headed,
    viewport: {
      width: 430,
      height: 820,
    },
  });

  page = await browser.newPage();
  attachPageTelemetry(page, telemetry);
  await routeWalletRelayToShim(page, options);
  const webauthn = await installVirtualAuthenticator(
    browser,
    page,
    options.credentialsPath,
  );
  await ensureWallet(page, options.walletUrl, options.timeoutMs, webauthn);

  const loginResult = await runCliLogin(page, options);

  if (loginResult.screenOnly) {
    console.log(
      `${options.authFlow === "device" ? "Device" : "Loopback"} auth screen assertions passed.`,
    );
    console.log(`Wallet UI: ${options.walletUrl}`);
    console.log(`Playwright profile: ${options.profileDir}`);
  } else {
    console.log(
      `${options.authFlow === "device" ? "Device" : "Loopback"} authorization completed.`,
    );
    console.log(`Account: ${loginResult.profile.accountAddress}`);
    if (loginResult.profile.keys[0]) {
      console.log(`Access key: ${loginResult.profile.keys[0].accessAddress}`);
      console.log(
        `Expires: ${new Date(loginResult.profile.keys[0].authorizedKey.expiry * 1000).toISOString()}`,
      );
    } else {
      console.log("Access key: none");
    }
    console.log(`CLI config: ${options.configDir}`);

    if (options.management) {
      await runKeyManagementE2E(page, options, loginResult.profile);
    }
  }

  if (options.hold) {
    console.log("Holding browser open. Press Ctrl+C to exit.");
    await new Promise(() => {});
  }
} catch (error) {
  const artifactDir = await writeFailureArtifacts({
    error,
    page,
    options,
    telemetry,
  });
  console.error(`Loopback E2E failed. Artifacts: ${artifactDir}`);
  throw error;
} finally {
  if (browser && !options.hold) {
    await browser.close();
  }
  await shim.close();
}

function parseArgs(args) {
  const parsed = {
    artifactsDir: resolve(defaultE2eDir, "artifacts"),
    e2eDir: defaultE2eDir,
    headed: false,
    hold: false,
    relayUrl: defaultRelayUrl,
    management: false,
    mockRelay: false,
    network: "mainnet",
    reset: false,
    screenOnly: false,
    authFlow: "loopback",
    shimPort: 4002,
    shimOnly: false,
    timeoutMs: 120_000,
    walletUrl: "http://localhost:4000",
    allowCalls: [],
  };
  let configDir;
  let credentialsPath;
  let permissionsFile;
  let profileDir;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--allow-call":
        parsed.allowCalls.push(readValue(args, ++index, arg));
        break;
      case "--":
        break;
      case "--artifacts-dir":
        parsed.artifactsDir = resolve(readValue(args, ++index, arg));
        break;
      case "--auth-flow": {
        const authFlow = readValue(args, ++index, arg);
        if (authFlow !== "loopback" && authFlow !== "device") {
          throw new Error("--auth-flow must be loopback or device");
        }
        parsed.authFlow = authFlow;
        break;
      }
      case "--config-dir":
        configDir = resolve(readValue(args, ++index, arg));
        break;
      case "--credentials-path":
        credentialsPath = resolve(readValue(args, ++index, arg));
        break;
      case "--e2e-dir":
        parsed.e2eDir = resolve(readValue(args, ++index, arg));
        break;
      case "--headed":
        parsed.headed = true;
        break;
      case "--hold":
        parsed.hold = true;
        break;
      case "--management":
        parsed.management = true;
        break;
      case "--mock-relay":
        parsed.mockRelay = true;
        break;
      case "--network": {
        const network = readValue(args, ++index, arg);
        if (!chainConfigs[network]) {
          throw new Error("--network must be mainnet or testnet");
        }
        parsed.network = network;
        break;
      }
      case "--profile-dir":
        profileDir = resolve(readValue(args, ++index, arg));
        break;
      case "--permissions":
        permissionsFile = resolve(readValue(args, ++index, arg));
        break;
      case "--relay-url":
        parsed.relayUrl = readValue(args, ++index, arg);
        break;
      case "--reset":
        parsed.reset = true;
        break;
      case "--screen-only":
        parsed.screenOnly = true;
        break;
      case "--shim-port":
        parsed.shimPort = parsePositiveInteger(
          readValue(args, ++index, arg),
          arg,
        );
        break;
      case "--shim-only":
        parsed.shimOnly = true;
        break;
      case "--timeout-ms":
        parsed.timeoutMs = parsePositiveInteger(
          readValue(args, ++index, arg),
          arg,
        );
        break;
      case "--wallet-url":
        parsed.walletUrl = stripTrailingSlash(readValue(args, ++index, arg));
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  parsed.walletUrl = stripTrailingSlash(parsed.walletUrl);
  parsed.configDir = configDir ?? resolve(parsed.e2eDir, "cli-config");
  parsed.credentialsPath =
    credentialsPath ?? resolve(parsed.e2eDir, "webauthn-credentials.json");
  parsed.permissionsFile = permissionsFile;
  parsed.profileDir = profileDir ?? resolve(parsed.e2eDir, "chromium-profile");
  if (parsed.artifactsDir === resolve(defaultE2eDir, "artifacts")) {
    parsed.artifactsDir = resolve(parsed.e2eDir, "artifacts");
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function e2eChainConfig(network) {
  const config = chainConfigs[network];
  if (!config) {
    throw new Error(`Unsupported E2E network: ${network}`);
  }
  return config;
}

function printHelp() {
  console.log(`Usage: npm run e2e:loopback -- [options]

Options:
  --auth-flow <flow>     Authorization flow: loopback or device (default: loopback)
  --screen-only          Stop after verifying the wallet permission screen
  --headed               Show the Playwright Chromium window
  --hold                 Keep the browser open after the check
  --management           Run live delegated-key management checks after login
  --mock-relay           Mock relay send/status/key RPCs in the local shim
  --network <network>    CLI wallet network: mainnet or testnet (default: mainnet)
  --reset                Delete .e2e state before starting
  --wallet-url <url>     Wallet UI URL (default: http://localhost:4000)
  --permissions <path>   Permission request JSON file
  --allow-call <scope>   Add target:signature call scope, repeatable
  --shim-port <port>     Local shim backend port (default: 4002)
  --shim-only            Start only the local shim backend
  --relay-url <url>      Relay proxy target (default: ${defaultRelayUrl})
  --timeout-ms <ms>      Login timeout (default: 120000)
  --profile-dir <path>   Playwright profile directory
  --credentials-path <p>  Virtual WebAuthn credentials file
  --artifacts-dir <path> Failure telemetry directory
  --config-dir <path>    Wallet CLI config directory`);
}

function createTelemetry() {
  return {
    console: [],
    network: [],
    pageErrors: [],
  };
}

function attachPageTelemetry(page, telemetry) {
  page.on("console", (message) => {
    telemetry.console.push({
      type: message.type(),
      text: redactTelemetry(message.text()),
      location: message.location(),
    });
  });

  page.on("pageerror", (error) => {
    telemetry.pageErrors.push({
      message: redactTelemetry(error.message),
      stack: redactTelemetry(error.stack ?? ""),
    });
  });

  page.on("requestfailed", (request) => {
    telemetry.network.push({
      kind: "requestfailed",
      method: request.method(),
      url: redactTelemetry(request.url()),
      failure: request.failure()?.errorText,
    });
  });

  page.on("response", (response) => {
    if (response.status() < 400) {
      return;
    }

    telemetry.network.push({
      kind: "http-error",
      method: response.request().method(),
      url: redactTelemetry(response.url()),
      status: response.status(),
      statusText: response.statusText(),
    });
  });
}

async function writeFailureArtifacts({ error, page, options, telemetry }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = resolve(options.artifactsDir, stamp);
  await mkdir(artifactDir, { recursive: true });

  const currentUrl = page?.url();
  const bodyText = page
    ? await page
        .locator("body")
        .innerText()
        .catch(() => "")
    : "";

  if (page) {
    await page
      .screenshot({
        path: resolve(artifactDir, "page.png"),
        fullPage: true,
      })
      .catch(() => undefined);
  }

  await writeFile(
    resolve(artifactDir, "error.json"),
    `${JSON.stringify(
      {
        message: redactTelemetry(
          error instanceof Error ? error.message : String(error),
        ),
        stack: redactTelemetry(
          error instanceof Error ? (error.stack ?? "") : "",
        ),
        pageUrl: currentUrl ? redactTelemetry(currentUrl) : undefined,
        walletUrl: options.walletUrl,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(resolve(artifactDir, "body.txt"), redactTelemetry(bodyText));
  await writeFile(
    resolve(artifactDir, "console.json"),
    `${JSON.stringify(telemetry.console.slice(-200), null, 2)}\n`,
  );
  await writeFile(
    resolve(artifactDir, "network.json"),
    `${JSON.stringify(telemetry.network.slice(-200), null, 2)}\n`,
  );
  await writeFile(
    resolve(artifactDir, "page-errors.json"),
    `${JSON.stringify(telemetry.pageErrors.slice(-50), null, 2)}\n`,
  );

  return artifactDir;
}

function redactTelemetry(value) {
  return value.replace(
    /(privateKey|api-token|Authorization|Bearer)(["':=\s]+)([^"',\s]+)/gi,
    "$1$2[redacted]",
  );
}

async function startShimBackend({
  mockRelay,
  network,
  port,
  statePath,
  relayUrl,
  walletUrl,
}) {
  const state = await readShimState(statePath);

  const server = createServer(async (request, response) => {
    try {
      await handleShimRequest(request, response, state, statePath, {
        mockRelay,
        network,
        relayUrl,
        walletUrl,
      });
    } catch (error) {
      json(response, request, 500, {
        error: error instanceof Error ? error.message : "shim backend error",
      });
    }
  });

  await new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, "127.0.0.1", resolveStart);
  }).catch(async (error) => {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }

    const existing = await existingShimHealth(port);
    if (existing) {
      console.log(
        `Using existing loopback E2E shim on http://127.0.0.1:${port}`,
      );
      return;
    }

    throw new Error(
      `port ${port} is already in use and is not the wallet-cli E2E shim`,
    );
  });

  if (server.listening) {
    console.log(`Loopback E2E shim listening on http://127.0.0.1:${port}`);
  }

  return {
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        if (!server.listening) {
          resolveClose();
          return;
        }
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
  };
}

async function existingShimHealth(port) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/__mega_cli_e2e/health`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function handleShimRequest(
  request,
  response,
  state,
  statePath,
  { mockRelay, network, relayUrl, walletUrl },
) {
  const chainConfig = e2eChainConfig(network);
  applyCors(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname === "/__mega_cli_e2e/health") {
    json(response, request, 200, { ok: true });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/v1/cli-auth/device/start"
  ) {
    const body = await readJson(request);
    const record = createDeviceAuthRecord(body, walletUrl);
    const { deviceCode, ...storedRecord } = record;
    state.deviceAuth[record.userCode] = storedRecord;
    await writeShimState(statePath, state);
    json(response, request, 200, {
      deviceCode,
      userCode: record.userCode,
      verificationUri: record.verificationUri,
      verificationUriComplete: record.verificationUriComplete,
      expiresIn: record.expiresIn,
      interval: record.interval,
    });
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/v1/cli-auth/device/token"
  ) {
    const body = await readJson(request);
    const record = findDeviceAuthByDeviceCode(state, body.deviceCode);
    if (!record) {
      json(response, request, 400, { error: "Invalid device authorization" });
      return;
    }
    if (!isValidDevicePkce(record, body.codeVerifier)) {
      json(response, request, 400, { error: "Invalid PKCE verifier" });
      return;
    }
    if (isExpiredDeviceAuth(record)) {
      record.status = "expired";
      await writeShimState(statePath, state);
      json(response, request, 200, { status: "expired_token" });
      return;
    }
    if (record.status === "rejected") {
      json(response, request, 200, {
        status: "access_denied",
        ...(record.rejectionError ? { error: record.rejectionError } : {}),
      });
      return;
    }
    if (record.status === "consumed") {
      json(response, request, 410, {
        error: "Device authorization already consumed",
      });
      return;
    }
    if (record.status === "approved") {
      record.status = "consumed";
      await writeShimState(statePath, state);
      json(response, request, 200, record.approval);
      return;
    }
    json(response, request, 200, {
      status: "authorization_pending",
      interval: record.interval,
    });
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname.startsWith("/v1/cli-auth/device/")
  ) {
    const userCode = normalizeDeviceUserCode(
      url.pathname.slice("/v1/cli-auth/device/".length),
    );
    const record = state.deviceAuth[userCode];
    if (!record) {
      json(response, request, 404, { error: "Device authorization not found" });
      return;
    }
    if (isExpiredDeviceAuth(record)) {
      record.status = "expired";
      await writeShimState(statePath, state);
      json(response, request, 410, { status: "expired_token" });
      return;
    }
    if (record.status !== "pending") {
      json(response, request, 400, {
        error: "Device authorization is not pending",
      });
      return;
    }
    json(response, request, 200, sanitizeDeviceLookup(record));
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname.startsWith("/v1/cli-auth/device/") &&
    url.pathname.endsWith("/approve")
  ) {
    const userCode = normalizeDeviceUserCode(
      url.pathname
        .slice("/v1/cli-auth/device/".length)
        .slice(0, -"/approve".length),
    );
    const record = state.deviceAuth[userCode];
    if (!record || record.status !== "pending") {
      json(response, request, 404, { error: "Device authorization not found" });
      return;
    }
    const body = await readJson(request);
    record.status = "approved";
    record.approval = buildDeviceApproval(record, body);
    await writeShimState(statePath, state);
    json(response, request, 200, record.approval);
    return;
  }

  if (
    request.method === "POST" &&
    url.pathname.startsWith("/v1/cli-auth/device/") &&
    url.pathname.endsWith("/reject")
  ) {
    const userCode = normalizeDeviceUserCode(
      url.pathname
        .slice("/v1/cli-auth/device/".length)
        .slice(0, -"/reject".length),
    );
    const record = state.deviceAuth[userCode];
    if (!record || record.status !== "pending") {
      json(response, request, 404, { error: "Device authorization not found" });
      return;
    }
    const body = await readJson(request);
    record.status = "rejected";
    record.rejectionError =
      typeof body.error === "string" ? body.error : undefined;
    await writeShimState(statePath, state);
    json(response, request, 200, { status: "rejected" });
    return;
  }

  if (url.pathname === "/rpc") {
    if (mockRelay) {
      await handleMockRelayRpc(request, response, state, relayUrl, chainConfig);
    } else {
      await proxyRelayRpc(request, response, relayUrl);
    }
    return;
  }

  if (request.method === "PUT" && url.pathname === "/__mega_cli_e2e/mock-key") {
    const body = await readJson(request);
    const id = normalizeAddress(body.id ?? body.accessAddress);
    state.mockKeys[id] = {
      chainId: chainConfig.chainIdHex,
      hash: body.hash ?? mockKeyHash(id),
      key: toRelayMockKey({
        expiry: body.expiry ?? 0,
        permissions: body.permissions,
        publicKey: body.publicKey ?? body.accessAddress,
      }),
    };
    await writeShimState(statePath, state);
    json(response, request, 200, { ok: true });
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/v1/apps" || url.pathname === "/v1/partners")
  ) {
    const origin = url.searchParams.get("origin") ?? "localhost:4000";
    json(response, request, 200, {
      id: "mega-cli-local",
      name: "Mega CLI",
      logo: "https://account.megaeth.com/logo.png",
      url: origin,
      logoTheme: "light",
      category: "developer",
      verified: true,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/balances") {
    json(response, request, 200, [
      {
        address: nativeTokenAddress,
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
        balance: "0",
        displayBalance: "0",
        usdPrice: "1",
        usdBalance: "0",
      },
      {
        address: chainConfig.usdmAddress,
        name: "MegaUSD",
        symbol: "USDM",
        decimals: 18,
        balance: "20000000000000000000",
        displayBalance: "20",
        usdPrice: "1",
        usdBalance: "20",
      },
      {
        address: chainConfig.usdt0Address,
        name: network === "mainnet" ? "USDT0" : "EXP",
        symbol: network === "mainnet" ? "USDT0" : "EXP",
        decimals: network === "mainnet" ? 6 : 18,
        balance: network === "mainnet" ? "5000000" : "5000000000000000000",
        displayBalance: "5",
        usdPrice: "1",
        usdBalance: "5",
      },
    ]);
    return;
  }

  if (request.method === "PUT" && url.pathname === "/v1/auth/start") {
    const body = await readJson(request);
    const walletAddress = normalizeAddress(body.walletAddress);
    const issuedAt = new Date().toISOString();
    const nonce = randomBytes(16).toString("hex");
    json(response, request, 200, {
      walletAddress,
      message: `Mega Wallet local E2E sign-in\nAddress: ${walletAddress}\nNonce: ${nonce}`,
      nonce,
      issuedAt,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/v1/auth/complete") {
    json(
      response,
      request,
      200,
      `local-e2e-token-${randomBytes(8).toString("hex")}`,
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/public-key-lookup") {
    const credentialId = url.searchParams.get("credentialId");
    json(
      response,
      request,
      200,
      credentialId
        ? (state.publicKeyLookup[credentialId]?.publicKey ?? null)
        : null,
    );
    return;
  }

  if (request.method === "PUT" && url.pathname === "/v1/public-key-lookup") {
    const body = await readJson(request);
    state.publicKeyLookup[body.credentialId] = {
      publicKey: body.publicKey,
      account: body.account,
    };
    await writeShimState(statePath, state);
    json(response, request, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/v1/wallet/")) {
    const address = normalizeAddress(url.pathname.slice("/v1/wallet/".length));
    json(response, request, 200, state.wallets[address] ?? null);
    return;
  }

  if (request.method === "PUT" && url.pathname === "/v1/wallet/alias") {
    const body = await readJson(request);
    const address = normalizeAddress(body.address);
    state.wallets[address] = {
      walletAddress: address,
      alias: address,
      primary: body.primary ?? true,
      backupAddress: body.backupAddress,
    };
    await writeShimState(statePath, state);
    json(response, request, 200, state.wallets[address]);
    return;
  }

  if (
    request.method === "PUT" &&
    (url.pathname === "/v1/activity/app-connect" ||
      url.pathname === "/v1/activity/app-session" ||
      url.pathname === "/v1/activity/app-contract" ||
      url.pathname === "/v1/activity/partner-connect" ||
      url.pathname === "/v1/activity/partner-session")
  ) {
    await readJson(request);
    json(response, request, 200, { ok: true });
    return;
  }

  json(response, request, 404, {
    error: `No wallet-cli E2E shim route for ${request.method} ${url.pathname}`,
  });
}

async function proxyRelayRpc(request, response, relayUrl, bodyOverride) {
  const body = bodyOverride ?? (await readRawBody(request));
  const requestText = body.toString("utf8");
  const requestSummary = summarizeRpcPayload(requestText);
  const relayResponse = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "content-type": request.headers["content-type"] ?? "application/json",
    },
    body,
  });
  const responseBuffer = Buffer.from(await relayResponse.arrayBuffer());
  const responseText = responseBuffer.toString("utf8");
  const responseSummary = summarizeRpcPayload(responseText);
  console.log(
    `[shim rpc] ${requestSummary} -> ${relayResponse.status} ${responseSummary}`,
  );

  response.writeHead(relayResponse.status, {
    "access-control-allow-origin": request.headers.origin ?? "*",
    "access-control-allow-credentials": "true",
    "content-type":
      relayResponse.headers.get("content-type") ?? "application/json",
  });
  response.end(responseBuffer);
}

function summarizeRpcPayload(text) {
  try {
    const body = JSON.parse(text);
    const entries = Array.isArray(body) ? body : [body];
    return entries
      .map((entry) => {
        const method = entry?.method ?? "unknown";
        const error = entry?.error;
        if (!error) return method;
        const message = String(error.message ?? error.details ?? "error");
        return `${method}:${message.slice(0, 180)}`;
      })
      .join(",");
  } catch {
    return text.slice(0, 180);
  }
}

async function handleMockRelayRpc(
  request,
  response,
  state,
  relayUrl,
  chainConfig,
) {
  const body = await readJson(request);
  const requests = Array.isArray(body) ? body : [body];
  if (requests.some((entry) => !isMockRelayMethod(entry?.method))) {
    await proxyRelayRpc(
      request,
      response,
      relayUrl,
      Buffer.from(JSON.stringify(body)),
    );
    return;
  }

  const results = requests.map((entry) =>
    mockRelayResult(entry, state, chainConfig),
  );
  json(response, request, 200, Array.isArray(body) ? results : results[0]);
}

function isMockRelayMethod(method) {
  return [
    "wallet_prepareCalls",
    "wallet_sendPreparedCalls",
    "wallet_sendCalls",
    "wallet_getCallsStatus",
    "wallet_getKeys",
  ].includes(method);
}

function mockRelayResult(entry, state, chainConfig) {
  const id = entry?.id ?? null;
  const method = entry?.method;

  switch (method) {
    case "wallet_prepareCalls":
      return mockPrepareCalls(entry);
    case "wallet_sendPreparedCalls":
    case "wallet_sendCalls":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          id: `0x${randomBytes(32).toString("hex")}`,
        },
      };
    case "wallet_getCallsStatus": {
      const callId = entry?.params?.[0]?.id ?? `0x${"11".repeat(32)}`;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          id: callId,
          receipts: [
            {
              blockHash: `0x${"22".repeat(32)}`,
              blockNumber: "0x1",
              chainId: chainConfig.chainIdHex,
              gasUsed: "0x5208",
              logs: [],
              status: "0x1",
              transactionHash: `0x${randomBytes(32).toString("hex")}`,
            },
          ],
          status: 200,
        },
      };
    }
    case "wallet_getKeys":
      return {
        jsonrpc: "2.0",
        id,
        result: buildMockKeysByChain(state.mockKeys),
      };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `mock relay does not implement ${method}`,
        },
      };
  }
}

function mockPrepareCalls(entry) {
  const id = entry?.id ?? null;
  const parameters = entry?.params?.[0] ?? {};
  const revokeKeys = parameters.capabilities?.revokeKeys ?? null;
  const authorizeKeys = parameters.capabilities?.authorizeKeys ?? null;

  return {
    jsonrpc: "2.0",
    id,
    result: {
      capabilities: {
        authorizeKeys: authorizeKeys
          ? authorizeKeys.map((key) => ({
              ...key,
              hash: mockKeyHashFromPublicKey(key.publicKey),
            }))
          : null,
        revokeKeys,
      },
      context: {},
      digest: `0x${randomBytes(32).toString("hex")}`,
      key: parameters.key ?? null,
      signature: `0x${randomBytes(65).toString("hex")}`,
      typedData: {
        domain: {},
        message: {},
        primaryType: "EIP712Domain",
        types: {},
      },
    },
  };
}

function buildMockKeysByChain(mockKeys) {
  const result = {};
  for (const entry of Object.values(mockKeys)) {
    result[entry.chainId] ??= [];
    result[entry.chainId].push({
      ...entry.key,
      hash: entry.hash,
    });
  }
  return result;
}

function toRelayMockKey({ expiry, permissions, publicKey }) {
  return {
    expiry: toHexQuantity(expiry),
    permissions: toRelayMockPermissions(permissions),
    prehash: false,
    publicKey,
    role: "normal",
    type: "secp256k1",
  };
}

function toRelayMockPermissions(permissions) {
  const result = [];

  if (permissions?.calls === undefined) {
    result.push({
      selector: anyCallSelector,
      to: anyCallTarget,
      type: "call",
    });
  }

  for (const call of permissions?.calls ?? []) {
    result.push({
      selector: call.signature ?? anyCallSelector,
      to: call.to ?? anyCallTarget,
      type: "call",
    });
  }

  for (const spend of permissions?.spend ?? []) {
    result.push({
      limit: toHexQuantity(spend.limit),
      period: spend.period,
      ...(spend.token === undefined ? {} : { token: spend.token }),
      type: "spend",
    });
  }

  return result;
}

function toHexQuantity(value) {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "number") {
    return `0x${BigInt(value).toString(16)}`;
  }
  if (typeof value === "string") {
    if (value.startsWith("0x")) {
      return value;
    }
    return `0x${BigInt(value).toString(16)}`;
  }
  throw new Error("expected bigint-compatible permission limit");
}

function mockKeyHash(id) {
  return `0x${id.slice(2).padStart(64, "0")}`;
}

function mockKeyHashFromPublicKey(publicKey) {
  if (typeof publicKey !== "string" || !/^0x[0-9a-fA-F]+$/.test(publicKey)) {
    return `0x${"00".repeat(32)}`;
  }
  return `0x${publicKey.slice(2).padStart(64, "0").slice(-64)}`;
}

function applyCors(request, response) {
  response.setHeader(
    "access-control-allow-origin",
    request.headers.origin ?? "*",
  );
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader(
    "access-control-allow-methods",
    "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  );
  response.setHeader(
    "access-control-allow-headers",
    request.headers["access-control-request-headers"] ??
      "authorization, content-type",
  );
}

function json(response, request, statusCode, body) {
  applyCors(request, response);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  const raw = await readRawBody(request);
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw.toString("utf8"));
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readShimState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      deviceAuth: parsed.deviceAuth ?? {},
      mockKeys: parsed.mockKeys ?? {},
      publicKeyLookup: parsed.publicKeyLookup ?? {},
      wallets: parsed.wallets ?? {},
    };
  } catch {
    return {
      deviceAuth: {},
      mockKeys: {},
      publicKeyLookup: {},
      wallets: {},
    };
  }
}

async function writeShimState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function createDeviceAuthRecord(request, walletUrl) {
  assertDeviceStartRequest(request);
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = createDeviceUserCode();
  const verificationUri = new URL("/cli-auth", walletUrl).toString();
  const verificationUriComplete = new URL(verificationUri);
  verificationUriComplete.searchParams.set("code", userCode);

  return {
    approval: undefined,
    clientName: request.clientName,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    createdAt: new Date().toISOString(),
    deviceCode,
    deviceCodeHash: hashDeviceCode(deviceCode),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    expiresIn: 600,
    interval: 1,
    network: request.network,
    operation: request.operation,
    request,
    status: "pending",
    userCode,
    verificationUri,
    verificationUriComplete: verificationUriComplete.toString(),
  };
}

function assertDeviceStartRequest(request) {
  if (!request || request.clientName !== "mega-cli") {
    throw new Error("device start clientName must be mega-cli");
  }
  if (!chainConfigs[request.network]) {
    throw new Error("device start network must be mainnet or testnet");
  }
  if (request.codeChallengeMethod !== "S256") {
    throw new Error("device start codeChallengeMethod must be S256");
  }
  if (
    request.operation !== "login" &&
    !/^0x[0-9a-fA-F]{40}$/.test(request.accessAddress ?? "")
  ) {
    throw new Error("device start accessAddress must be a 20-byte address");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(request.codeChallenge ?? "")) {
    throw new Error("device start codeChallenge must be base64url");
  }
  if (typeof request.state !== "string" || request.state.length < 16) {
    throw new Error("device start state is required");
  }
  if (request.operation === "grant" && !request.permissions) {
    throw new Error("device grant permissions are required");
  }
  if (
    request.operation === "revoke" &&
    !/^0x[0-9a-fA-F]{40}$/.test(request.accountAddress ?? "")
  ) {
    throw new Error("device revoke accountAddress must be a 20-byte address");
  }
}

function createDeviceUserCode() {
  const bytes = randomBytes(8);
  const chars = [...bytes].map(
    (byte) => deviceUserCodeAlphabet[byte % deviceUserCodeAlphabet.length],
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function normalizeDeviceUserCode(userCode) {
  const compact = decodeURIComponent(userCode)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : compact;
}

function findDeviceAuthByDeviceCode(state, deviceCode) {
  const hash = hashDeviceCode(deviceCode);
  return Object.values(state.deviceAuth).find(
    (record) => record.deviceCodeHash === hash,
  );
}

function hashDeviceCode(deviceCode) {
  return createHash("sha256").update(String(deviceCode)).digest("base64url");
}

function isValidDevicePkce(record, codeVerifier) {
  if (record.codeChallengeMethod !== "S256") {
    return false;
  }
  if (typeof codeVerifier !== "string") {
    return false;
  }
  return (
    createHash("sha256").update(codeVerifier).digest("base64url") ===
    record.codeChallenge
  );
}

function isExpiredDeviceAuth(record) {
  return new Date(record.expiresAt).getTime() <= Date.now();
}

function sanitizeDeviceLookup(record) {
  const stored = record.request;
  return {
    clientName: record.clientName,
    expiresAt: record.expiresAt,
    interval: record.interval,
    network: record.network,
    operation: record.operation,
    request:
      record.operation === "login"
        ? {
            clientName: stored.clientName,
            network: stored.network,
            operation: stored.operation,
          }
        : record.operation === "grant"
          ? {
              accessAddress: stored.accessAddress,
              clientName: stored.clientName,
              existingAccountAddress: stored.existingAccountAddress,
              network: stored.network,
              operation: stored.operation,
              permissions: stored.permissions,
            }
          : {
              accessAddress: stored.accessAddress,
              accountAddress: stored.accountAddress,
              clientName: stored.clientName,
              network: stored.network,
              operation: stored.operation,
            },
    status: record.status,
    userCode: record.userCode,
  };
}

function buildDeviceApproval(record, body) {
  if (record.operation === "login") {
    return {
      status: "approved",
      operation: "login",
      state: record.request.state,
      accountAddress: normalizeAddress(body.accountAddress),
    };
  }

  if (record.operation === "grant") {
    return {
      status: "approved",
      operation: "grant",
      state: record.request.state,
      accountAddress: normalizeAddress(body.accountAddress),
      accessAddress: normalizeAddress(body.accessAddress),
      authorizedKey: body.authorizedKey,
      ...(body.grantTxHash ? { grantTxHash: body.grantTxHash } : {}),
    };
  }

  return {
    status: "approved",
    operation: "revoke",
    state: record.request.state,
    accountAddress: normalizeAddress(body.accountAddress),
    accessAddress: normalizeAddress(body.accessAddress),
    ...(body.revokeTxHash ? { revokeTxHash: body.revokeTxHash } : {}),
  };
}

async function routeWalletRelayToShim(page, runOptions) {
  const relayOrigin = new URL(defaultRelayUrl).origin;
  await page.route(`${relayOrigin}/**`, async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    const shimPath = target.pathname === "/" ? "/rpc" : target.pathname;
    const shimUrl = `${shimApiUrl(runOptions)}${shimPath}${target.search}`;
    const response = await route.fetch({ url: shimUrl });
    await route.fulfill({ response });
  });
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("expected 20-byte hex address");
  }
  return value.toLowerCase();
}

async function waitForWalletUi(walletUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(walletUrl);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${walletUrl} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }

  throw new Error(
    `wallet UI is not reachable at ${walletUrl}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

async function installVirtualAuthenticator(context, page, credentialsPath) {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );

  const credentials = await readWebAuthnCredentials(credentialsPath);
  for (const credential of credentials) {
    await session.send("WebAuthn.addCredential", {
      authenticatorId,
      credential,
    });
  }
  if (credentials.length > 0) {
    console.log(
      `Restored ${credentials.length} virtual WebAuthn credential(s) from ${credentialsPath}`,
    );
  }

  return {
    restoredCount: credentials.length,
    saveCredentials: async () => {
      const { credentials: currentCredentials } = await session.send(
        "WebAuthn.getCredentials",
        {
          authenticatorId,
        },
      );
      await writeWebAuthnCredentials(credentialsPath, currentCredentials);
      console.log(
        `Saved ${currentCredentials.length} virtual WebAuthn credential(s) to ${credentialsPath}`,
      );
    },
  };
}

async function readWebAuthnCredentials(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed.credentials)) {
      return parsed.credentials;
    }
  } catch {
    return [];
  }
  return [];
}

async function writeWebAuthnCredentials(path, credentials) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        credentials,
      },
      null,
      2,
    )}\n`,
    {
      mode: 0o600,
    },
  );
}

async function ensureWallet(page, walletUrl, timeoutMs, webauthn) {
  await page.goto(`${walletUrl}/connect`, { waitUntil: "domcontentloaded" });
  const existing = await readStoredAccount(page);
  if (existing?.address) {
    if (webauthn.restoredCount === 0) {
      console.log(
        "Existing wallet metadata found without saved virtual WebAuthn credentials; resetting E2E wallet state.",
      );
      await clearStoredWallet(page);
      await page.goto(`${walletUrl}/connect`, {
        waitUntil: "domcontentloaded",
      });
    } else {
      console.log(`Using existing Playwright wallet ${existing.address}`);
      return;
    }
  }

  if (webauthn.restoredCount > 0) {
    console.log("Restoring Playwright wallet from saved WebAuthn credential");
    await page.getByText("Sign in", { exact: true }).click();
    try {
      const restored = await waitForStoredAccount(
        page,
        Math.min(timeoutMs, 30_000),
      );
      console.log(`Restored Playwright wallet ${restored.address}`);
      return;
    } catch (error) {
      console.log(
        `Stored WebAuthn credential did not restore a wallet; creating a new wallet instead. ${
          error instanceof Error ? error.message : ""
        }`,
      );
      await clearStoredWallet(page);
      await page.goto(`${walletUrl}/connect`, {
        waitUntil: "domcontentloaded",
      });
    }
  }

  const current = await readStoredAccount(page);
  if (current?.address) {
    console.log(`Using existing Playwright wallet ${current.address}`);
    return;
  }

  console.log("Creating Playwright passkey wallet");
  await page
    .getByRole("button", { name: /^(Create PassKey|Create Account)$/ })
    .click();
  const terms = page.getByText(/I have read, understood, and agree/);
  if (await terms.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await terms.click();
    await page.getByRole("button", { name: "Create Account" }).click();
  }
  const stored = await waitForStoredAccount(page, timeoutMs);
  await webauthn.saveCredentials();
  console.log(`Created Playwright wallet ${stored.address}`);
}

async function readStoredAccount(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("key");
    return raw ? JSON.parse(raw) : null;
  });
}

async function clearStoredWallet(page) {
  await page.evaluate(() => {
    localStorage.removeItem("key");
    localStorage.removeItem("api-token");
  });
}

async function waitForStoredAccount(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const raw = localStorage.getItem("key");
        if (!raw) {
          return false;
        }
        const parsed = JSON.parse(raw);
        return Boolean(parsed?.address);
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch (error) {
    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    throw new Error(
      `wallet creation did not finish: ${
        error instanceof Error ? error.message : "timeout"
      }\n${body}`,
    );
  }

  return readStoredAccount(page);
}

async function runCliLogin(page, runOptions) {
  if (runOptions.authFlow === "device") {
    return runDeviceCliLogin(page, runOptions);
  }

  const { runLoopbackLogin } = await import(
    pathToFileURL(resolve(repoRoot, "dist/auth/loopback.js")).href
  );

  try {
    const result = await runLoopbackLogin({
      network: runOptions.network,
      relayUrl: runOptions.relayUrl,
      walletUrl: runOptions.walletUrl,
      timeoutMs: runOptions.timeoutMs,
      env: {
        ...process.env,
        MEGA_WALLET_CLI_CONFIG_DIR: runOptions.configDir,
      },
      openBrowser: async (authUrl) => {
        await gotoWalletAuth(page, authUrl);
        await assertLoginScreen(page, runOptions.timeoutMs);

        if (runOptions.screenOnly) {
          throw new ScreenOnlyComplete();
        }

        await approveLoopback(page, "Approve", runOptions.timeoutMs);
      },
    });
    return {
      screenOnly: false,
      profile: result.profile,
    };
  } catch (error) {
    if (runOptions.screenOnly && error instanceof ScreenOnlyComplete) {
      return { screenOnly: true };
    }
    throw error;
  }
}

async function runDeviceCliLogin(page, runOptions) {
  const walletCommands = await import(
    pathToFileURL(resolve(repoRoot, "dist/commands/wallet.js")).href
  );
  const env = {
    ...process.env,
    MEGA_WALLET_CLI_CONFIG_DIR: runOptions.configDir,
  };

  try {
    const profile = await walletCommands.login(
      {
        authFlow: "device",
        network: runOptions.network,
        relayUrl: runOptions.relayUrl,
        timeoutMs: runOptions.timeoutMs,
        walletApiUrl: shimApiUrl(runOptions),
        walletUrl: runOptions.walletUrl,
      },
      {
        authorizeDeviceLogin: createDeviceLoginAuthorizer(page, runOptions, {
          screenOnly: runOptions.screenOnly,
        }),
        env,
      },
    );

    return {
      screenOnly: false,
      profile,
    };
  } catch (error) {
    if (runOptions.screenOnly && error instanceof ScreenOnlyComplete) {
      return { screenOnly: true };
    }
    throw error;
  }
}

function createDeviceKeyAuthorizer(
  page,
  runOptions,
  { screenOnly = false } = {},
) {
  return async (authorizationOptions) => {
    const { authorizeDeviceKey } = await import(
      pathToFileURL(resolve(repoRoot, "dist/auth/device.js")).href
    );
    let promptTask = Promise.resolve();

    return authorizeDeviceKey({
      ...authorizationOptions,
      sleep: async (ms) => {
        await promptTask;
        await delay(Math.min(ms, 500));
      },
      onPrompt: (prompt) => {
        promptTask = handleDeviceGrantPrompt(page, prompt, runOptions, {
          screenOnly,
        });
      },
    });
  };
}

function createDeviceLoginAuthorizer(
  page,
  runOptions,
  { screenOnly = false } = {},
) {
  return async (authorizationOptions) => {
    const { authorizeDeviceLogin } = await import(
      pathToFileURL(resolve(repoRoot, "dist/auth/device.js")).href
    );
    let promptTask = Promise.resolve();

    return authorizeDeviceLogin({
      ...authorizationOptions,
      sleep: async (ms) => {
        await promptTask;
        await delay(Math.min(ms, 500));
      },
      onPrompt: (prompt) => {
        promptTask = handleDeviceLoginPrompt(page, prompt, runOptions, {
          screenOnly,
        });
      },
    });
  };
}

function createDeviceRevokeAuthorizer(page, runOptions) {
  return async (authorizationOptions) => {
    const { authorizeDeviceRevoke } = await import(
      pathToFileURL(resolve(repoRoot, "dist/auth/device.js")).href
    );
    let promptTask = Promise.resolve();

    return authorizeDeviceRevoke({
      ...authorizationOptions,
      sleep: async (ms) => {
        await promptTask;
        await delay(Math.min(ms, 500));
      },
      onPrompt: (prompt) => {
        promptTask = handleDeviceRevokePrompt(page, prompt, runOptions);
      },
    });
  };
}

async function handleDeviceGrantPrompt(
  page,
  prompt,
  runOptions,
  { screenOnly },
) {
  await page.goto(prompt.verificationUriComplete, {
    waitUntil: "domcontentloaded",
  });
  await assertDeviceRequestScreen(page, prompt.userCode, runOptions.timeoutMs);

  if (screenOnly) {
    throw new ScreenOnlyComplete();
  }

  await page.getByRole("button", { name: "Approve CLI Key" }).click();
  await assertPermissionScreen(page, runOptions.timeoutMs, runOptions);

  await page.getByRole("button", { name: "Approve" }).click();
}

async function handleDeviceLoginPrompt(
  page,
  prompt,
  runOptions,
  { screenOnly },
) {
  await page.goto(prompt.verificationUriComplete, {
    waitUntil: "domcontentloaded",
  });
  await assertDeviceRequestScreen(page, prompt.userCode, runOptions.timeoutMs);

  if (screenOnly) {
    throw new ScreenOnlyComplete();
  }

  await page.getByRole("button", { name: "Approve CLI Login" }).click();
  await waitForBodyText(
    page,
    (text) => text.includes("CLI request approved"),
    "device login approval",
    runOptions.timeoutMs,
  );
}

async function handleDeviceRevokePrompt(page, prompt, runOptions) {
  await page.goto(prompt.verificationUriComplete, {
    waitUntil: "domcontentloaded",
  });
  await assertDeviceRequestScreen(page, prompt.userCode, runOptions.timeoutMs);
  await page.getByRole("button", { name: "Revoke CLI Key" }).click();
  await waitForBodyText(
    page,
    (text) => text.includes("CLI request approved"),
    "device revoke approval",
    runOptions.timeoutMs,
  );
}

async function assertDeviceRequestScreen(page, userCode, timeoutMs) {
  await waitForBodyText(
    page,
    (text) => text.includes("Request details") && text.includes(userCode),
    "device authorization request details",
    timeoutMs,
  );
}

async function assertLoginScreen(page, timeoutMs) {
  await waitForBodyText(
    page,
    (text) =>
      /mega cli/i.test(text) && (/connect/i.test(text) || /login/i.test(text)),
    "CLI login screen",
    timeoutMs,
  );
}

function shimApiUrl(runOptions) {
  return `http://127.0.0.1:${runOptions.shimPort}`;
}

function createManagementKeyOptions(runOptions, label) {
  return {
    allowCall:
      runOptions.permissionsFile || runOptions.allowCalls.length > 0
        ? runOptions.allowCalls
        : [`${anyCallTarget}:${anyCallSelector}`],
    authFlow: runOptions.authFlow,
    label,
    network: runOptions.network,
    permissions: runOptions.permissionsFile,
    relayUrl: runOptions.relayUrl,
    timeoutMs: runOptions.timeoutMs,
    walletApiUrl: shimApiUrl(runOptions),
    walletUrl: runOptions.walletUrl,
  };
}

async function runKeyManagementE2E(page, runOptions, initialProfile) {
  const [walletCommands, loopback, profileStore] = await Promise.all([
    import(pathToFileURL(resolve(repoRoot, "dist/commands/wallet.js")).href),
    import(pathToFileURL(resolve(repoRoot, "dist/auth/loopback.js")).href),
    import(pathToFileURL(resolve(repoRoot, "dist/config/profile.js")).href),
  ]);
  const env = {
    ...process.env,
    MEGA_WALLET_CLI_CONFIG_DIR: runOptions.configDir,
  };

  console.log("Running delegated-key management E2E...");

  let firstKey = initialProfile.keys[0];
  if (!firstKey?.id) {
    const bootstrap = await withOutput((stdout) =>
      walletCommands.runWalletCreateKey(
        createManagementKeyOptions(runOptions, "e2e-bootstrap"),
        {
          ...(runOptions.authFlow === "device"
            ? {
                authorizeDeviceKey: createDeviceKeyAuthorizer(page, runOptions),
              }
            : {
                authorizeKey: (options) =>
                  loopback.authorizeLoopbackKey({
                    ...options,
                    env,
                    openBrowser: async (authUrl) => {
                      await gotoWalletAuth(page, authUrl);
                      await assertPermissionScreen(
                        page,
                        runOptions.timeoutMs,
                        runOptions,
                      );
                      await approveLoopback(
                        page,
                        "Approve",
                        runOptions.timeoutMs,
                      );
                    },
                  }),
              }),
          env,
          stdout,
        },
      ),
    );
    firstKey = bootstrap.result.key;
  }

  const created = await withOutput((stdout) =>
    walletCommands.runWalletCreateKey(
      createManagementKeyOptions(runOptions, "e2e-management"),
      {
        ...(runOptions.authFlow === "device"
          ? {
              authorizeDeviceKey: createDeviceKeyAuthorizer(page, runOptions),
            }
          : {
              authorizeKey: (options) =>
                loopback.authorizeLoopbackKey({
                  ...options,
                  env,
                  openBrowser: async (authUrl) => {
                    await gotoWalletAuth(page, authUrl);
                    await assertPermissionScreen(
                      page,
                      runOptions.timeoutMs,
                      runOptions,
                    );
                    await approveLoopback(
                      page,
                      "Approve",
                      runOptions.timeoutMs,
                    );
                  },
                }),
            }),
        env,
        stdout,
      },
    ),
  );
  const secondKey = created.result.key;
  assert(
    secondKey.id.toLowerCase() !== firstKey.id.toLowerCase(),
    "create-key reused the existing key id",
  );
  assertIncludes(created.stdout, "This key is now the default");
  if (runOptions.mockRelay) {
    await fetch(
      `http://127.0.0.1:${runOptions.shimPort}/__mega_cli_e2e/mock-key`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          accessAddress: secondKey.accessAddress,
          expiry: secondKey.authorizedKey.expiry,
          id: secondKey.id,
          permissions: secondKey.authorizedKey.permissions,
          publicKey: secondKey.authorizedKey.publicKey,
        }),
      },
    );
  }

  const listAfterCreate = await withOutput((stdout) =>
    walletCommands.runWalletList(
      { network: runOptions.network, showInactive: true, json: true },
      { env, stdout },
    ),
  );
  assert(
    listAfterCreate.result.keys.length >= 2,
    "expected list to include both delegated keys",
  );
  assert(
    listAfterCreate.result.keys.some(
      (key) => key.id.toLowerCase() === secondKey.id.toLowerCase(),
    ),
    "created key missing from list output",
  );

  const permissions = await withOutput((stdout) =>
    walletCommands.runWalletPermissions(
      secondKey.id,
      { network: runOptions.network },
      { env, stdout },
    ),
  );
  if (runOptions.permissionsFile) {
    await assertPermissionsOutput(permissions.stdout, runOptions);
  } else {
    assertIncludes(permissions.stdout, "Can spend up to 100 USDm per week");
  }

  await withOutput((stdout) =>
    walletCommands.runWalletLabel(
      secondKey.id,
      "e2e-renamed",
      { network: runOptions.network, terse: true },
      { env, stdout },
    ),
  );

  const switchFirst = await withOutput((stdout) =>
    walletCommands.runWalletSwitch(
      firstKey.id,
      { network: runOptions.network, terse: true },
      { env, stdout },
    ),
  );
  assertIncludes(switchFirst.stdout, firstKey.id);

  const switchSecond = await withOutput((stdout) =>
    walletCommands.runWalletSwitch(
      secondKey.id,
      { network: runOptions.network, terse: true },
      { env, stdout },
    ),
  );
  assertIncludes(switchSecond.stdout, secondKey.id);

  const revoked = await withOutput((stdout) =>
    walletCommands.runWalletRevoke(
      secondKey.id,
      {
        authFlow: runOptions.authFlow,
        network: runOptions.network,
        timeoutMs: runOptions.timeoutMs,
        walletApiUrl: shimApiUrl(runOptions),
        walletUrl: runOptions.walletUrl,
      },
      {
        env,
        ...(runOptions.authFlow === "device"
          ? {
              revokeDeviceKey: createDeviceRevokeAuthorizer(page, runOptions),
            }
          : {
              revokeKey: (options) =>
                loopback.runLoopbackRevoke({
                  ...options,
                  openBrowser: async (authUrl) => {
                    await gotoWalletAuth(page, authUrl);
                    await page
                      .getByText(/Revok(e|ing) Mega CLI Key/)
                      .waitFor({ timeout: runOptions.timeoutMs / 2 })
                      .catch(() => undefined);
                  },
                }),
            }),
        stdout,
      },
    ),
  );
  assertEqual(
    revoked.result.key.effectiveStatus,
    "revoked",
    "revoked key should be inactive locally",
  );

  const stored = await profileStore.readWalletProfile(runOptions.network, env);
  const storedRevoked = stored.keys.find(
    (key) => key.id.toLowerCase() === secondKey.id.toLowerCase(),
  );
  assert(storedRevoked, "revoked key missing from local audit log");
  assertEqual(storedRevoked.status, "revoked", "key status was not revoked");
  assert(
    !Object.hasOwn(storedRevoked, "privateKey"),
    "revoked key retained privateKey material",
  );

  await withOutput((stdout) =>
    walletCommands.runWalletSwitch(
      firstKey.id,
      { network: runOptions.network, terse: true },
      { env, stdout },
    ),
  );

  console.log("Delegated-key management E2E completed.");
  console.log(`Created/revoked key: ${secondKey.accessAddress}`);
  console.log(`Restored active key: ${firstKey.accessAddress}`);
}

async function withOutput(action) {
  const stdout = memoryOutput();
  const result = await action(stdout);
  return {
    result,
    stdout: stdout.text,
  };
}

function memoryOutput() {
  let text = "";

  return {
    get text() {
      return text;
    },
    write(chunk) {
      text += chunk;
    },
  };
}

async function assertPermissionScreen(page, timeoutMs, runOptions) {
  await page.getByText("Permissions Requested", { exact: true }).waitFor({
    timeout: timeoutMs,
  });

  if (runOptions?.permissionsFile) {
    const request = await readPermissionRequest(runOptions.permissionsFile);
    for (const spend of request.permissions.spend ?? []) {
      const expected = expectedSpendText(spend, runOptions.network);
      await waitForBodyText(
        page,
        (text) => normalizeText(text).includes(expected),
        `${expected} permission`,
        timeoutMs,
      );
    }
    if (request.feeToken?.limit && request.feeToken?.symbol) {
      await waitForBodyText(
        page,
        (text) =>
          normalizeText(text).includes(request.feeToken.limit) &&
          normalizeText(text).includes(request.feeToken.symbol.toUpperCase()),
        `${request.feeToken.limit} ${request.feeToken.symbol} fee permission`,
        timeoutMs,
      );
    }
    return;
  }

  await waitForBodyText(
    page,
    (text) => /Spend up to\s+100\s+USDM/i.test(text),
    "100 USDM spend permission",
    timeoutMs,
  );

  const body = await page.locator("body").innerText();
  assertMissing(body, "total over the next week");
  assertMissing(body, "No token spend requested");
  assertMissing(body, "Create offline transactions");
  assertMissing(body, "Pay up to 0 ETH in fees");
  assertMissing(body, "Pay up to 0 eth in fees");
  assertMissing(body, "$1 USDM");
}

async function assertPermissionsOutput(stdout, runOptions) {
  const request = await readPermissionRequest(runOptions.permissionsFile);
  for (const spend of request.permissions.spend ?? []) {
    assertIncludes(stdout, expectedStoredSpendLine(spend, runOptions.network));
  }
  if (request.feeToken?.limit && request.feeToken?.symbol) {
    assertIncludes(
      stdout,
      `Can pay up to ${request.feeToken.limit} ${formatSymbol(
        request.feeToken.symbol,
      )} in relay fees`,
    );
  }
}

async function readPermissionRequest(permissionsFile) {
  const value = JSON.parse(await readFile(permissionsFile, "utf8"));
  if (!value?.permissions || !Array.isArray(value.permissions.spend)) {
    throw new Error("permissions file is missing permissions.spend");
  }
  return value;
}

function expectedStoredSpendLine(spend, network) {
  const token = permissionSpendToken(spend, network);
  return `Can spend up to ${formatBaseUnits(spend.limit, token.decimals)} ${
    token.symbol
  } per ${spend.period}`;
}

function expectedSpendText(spend, network) {
  const token = permissionSpendToken(spend, network);
  return `Spend up to ${formatBaseUnits(spend.limit, token.decimals)} ${
    token.symbol
  } per ${spend.period}`;
}

function permissionSpendToken(spend, network) {
  if (
    !spend.token ||
    spend.token.toLowerCase() === "0x0000000000000000000000000000000000000000"
  ) {
    return { decimals: 18, symbol: "ETH" };
  }
  const normalized = spend.token.toLowerCase();
  const config = chainConfigs[network];
  if (normalized === config.usdmAddress.toLowerCase()) {
    return { decimals: 18, symbol: "USDm" };
  }
  if (normalized === config.usdt0Address.toLowerCase()) {
    return { decimals: network === "mainnet" ? 6 : 18, symbol: "USDT0" };
  }
  return {
    decimals: 18,
    symbol: `${spend.token.slice(0, 6)}...${spend.token.slice(-4)}`,
  };
}

function formatBaseUnits(value, decimals) {
  const units = BigInt(value.toString());
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = units % scale;
  if (fraction === 0n) return whole.toString();
  const trimmed = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/u, "");
  return `${whole}.${trimmed}`;
}

function formatSymbol(symbol) {
  return symbol.toLowerCase() === "usdm" ? "USDm" : symbol;
}

function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function assertMissing(text, forbidden) {
  if (text.includes(forbidden)) {
    throw new Error(
      `permission screen still contains unexpected copy: ${forbidden}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`expected output to include ${expected}`);
  }
}

async function waitForBodyText(page, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let body = "";

  while (Date.now() < deadline) {
    body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    if (predicate(body)) {
      return;
    }
    await delay(250);
  }

  throw new Error(`permission screen missing ${label}\n\n${body}`);
}

async function gotoWalletAuth(page, authUrl) {
  await settlePageNavigation(page);
  await page.goto(authUrl, { waitUntil: "domcontentloaded" });
}

async function approveLoopback(page, buttonName, timeoutMs) {
  await page.getByRole("button", { name: buttonName }).click();
  await page
    .waitForURL(/(127\.0\.0\.1|localhost|\[::1\]):\d+\/callback/u, {
      timeout: Math.min(timeoutMs, 5000),
    })
    .catch(() => undefined);
  await settlePageNavigation(page);
}

async function settlePageNavigation(page) {
  await delay(75);
  await page
    .waitForLoadState("domcontentloaded", { timeout: 2000 })
    .catch(() => undefined);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
