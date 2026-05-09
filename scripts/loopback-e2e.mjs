#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultE2eDir = resolve(repoRoot, ".e2e");
const usdmAddress = "0xfafddbb3fc7688494971a79cc65dca3ef82079e7";
const nativeTokenAddress = "0x0000000000000000000000000000000000000000";
const defaultRelayUrl = "https://wallet-relay.megaeth.com";

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
  port: options.shimPort,
  statePath: resolve(options.e2eDir, "shim-state.json"),
  relayUrl: options.relayUrl,
});

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
  const webauthn = await installVirtualAuthenticator(
    browser,
    page,
    options.credentialsPath,
  );
  await ensureWallet(page, options.walletUrl, options.timeoutMs, webauthn);

  const loginResult = await runCliLogin(page, options);

  if (loginResult.screenOnly) {
    console.log("Loopback auth screen assertions passed.");
    console.log(`Wallet UI: ${options.walletUrl}`);
    console.log(`Playwright profile: ${options.profileDir}`);
  } else {
    console.log("Loopback authorization completed.");
    console.log(`Account: ${loginResult.profile.accountAddress}`);
    console.log(`Access key: ${loginResult.profile.accessAddress}`);
    console.log(
      `Expires: ${new Date(loginResult.profile.authorizedKey.expiry * 1000).toISOString()}`,
    );
    console.log(`CLI config: ${options.configDir}`);
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
    reset: false,
    screenOnly: false,
    shimPort: 4002,
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
      case "--artifacts-dir":
        parsed.artifactsDir = resolve(readValue(args, ++index, arg));
        break;
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

function printHelp() {
  console.log(`Usage: npm run e2e:loopback -- [options]

Options:
  --screen-only          Stop after verifying the wallet permission screen
  --headed               Show the Playwright Chromium window
  --hold                 Keep the browser open after the check
  --reset                Delete .e2e state before starting
  --wallet-url <url>     Wallet UI URL (default: http://localhost:4000)
  --permissions <path>   Permission request JSON file
  --allow-call <scope>   Add target:signature call scope, repeatable
  --shim-port <port>     Local shim backend port (default: 4002)
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

async function startShimBackend({ port, statePath, relayUrl }) {
  const state = await readShimState(statePath);

  const server = createServer(async (request, response) => {
    try {
      await handleShimRequest(request, response, state, statePath, relayUrl);
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
  relayUrl,
) {
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

  if (url.pathname === "/rpc") {
    await proxyRelayRpc(request, response, relayUrl);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/partners") {
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
        balance: "1000000000000000000",
        displayBalance: "1",
        usdPrice: "1",
        usdBalance: "1",
      },
      {
        address: usdmAddress,
        name: "MegaUSD",
        symbol: "USDM",
        decimals: 18,
        balance: "20000000000000000000",
        displayBalance: "20",
        usdPrice: "1",
        usdBalance: "20",
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
    (url.pathname === "/v1/activity/partner-connect" ||
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

async function proxyRelayRpc(request, response, relayUrl) {
  const body = await readRawBody(request);
  const relayResponse = await fetch(relayUrl, {
    method: "POST",
    headers: {
      "content-type": request.headers["content-type"] ?? "application/json",
    },
    body,
  });

  response.writeHead(relayResponse.status, {
    "access-control-allow-origin": request.headers.origin ?? "*",
    "access-control-allow-credentials": "true",
    "content-type":
      relayResponse.headers.get("content-type") ?? "application/json",
  });
  response.end(Buffer.from(await relayResponse.arrayBuffer()));
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
      publicKeyLookup: parsed.publicKeyLookup ?? {},
      wallets: parsed.wallets ?? {},
    };
  } catch {
    return {
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
  await page.getByText("Create PassKey", { exact: true }).click();
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
  const [{ runLoopbackLogin }, { resolveLoginPermissions }] = await Promise.all(
    [
      import(pathToFileURL(resolve(repoRoot, "dist/auth/loopback.js")).href),
      import(pathToFileURL(resolve(repoRoot, "dist/auth/permissions.js")).href),
    ],
  );
  const permissionRequest = await resolveLoginPermissions({
    allowCalls: runOptions.allowCalls,
    permissionsFile: runOptions.permissionsFile,
  });

  try {
    const result = await runLoopbackLogin({
      network: "mainnet",
      permissionRequest,
      relayUrl: runOptions.relayUrl,
      walletUrl: runOptions.walletUrl,
      timeoutMs: runOptions.timeoutMs,
      env: {
        ...process.env,
        MEGA_WALLET_CLI_CONFIG_DIR: runOptions.configDir,
      },
      openBrowser: async (authUrl) => {
        await page.goto(authUrl, { waitUntil: "domcontentloaded" });
        await assertPermissionScreen(page, runOptions.timeoutMs);

        if (runOptions.screenOnly) {
          throw new ScreenOnlyComplete();
        }

        await page.getByRole("button", { name: "Approve" }).click();
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

async function assertPermissionScreen(page, timeoutMs) {
  await page.getByText("Permissions Requested", { exact: true }).waitFor({
    timeout: timeoutMs,
  });
  await waitForBodyText(
    page,
    (text) => /Spend up to\s+100\s+\S+\s+total over the next week/i.test(text),
    "100 USDM/week spend permission",
    timeoutMs,
  );

  const body = await page.locator("body").innerText();
  assertMissing(body, "No token spend requested");
  assertMissing(body, "Create offline transactions");
  assertMissing(body, "Pay up to 0 ETH in fees");
  assertMissing(body, "Pay up to 0 eth in fees");
}

function assertMissing(text, forbidden) {
  if (text.includes(forbidden)) {
    throw new Error(
      `permission screen still contains unexpected copy: ${forbidden}`,
    );
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
