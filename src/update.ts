import { execFile } from "node:child_process";

import { CliError } from "./errors.js";
import { cliReleaseVersion } from "./version.js";

const defaultRepo = "megaeth-labs/wallet-cli";
const defaultInstallUrl = "https://account.megaeth.com/install";

export type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
};

export type UpdateResult = UpdateCheck & {
  checkedOnly: boolean;
  updated: boolean;
};

export type UpdateRunner = (options: {
  env: NodeJS.ProcessEnv;
  installUrl: string;
  stderr?: (chunk: string) => void;
  version: string;
}) => Promise<void>;

export type UpdateDependencies = {
  fetch?: typeof fetch;
  runInstaller?: UpdateRunner;
};

export async function checkForUpdate(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: UpdateDependencies = {},
): Promise<UpdateCheck> {
  const currentVersion = resolveCurrentVersion(env);
  const latestVersion = await fetchLatestVersion(env, dependencies.fetch);

  return {
    currentVersion,
    latestVersion,
    updateAvailable: latestVersion !== currentVersion,
  };
}

export async function updateCli(
  options: {
    checkOnly?: boolean;
    env?: NodeJS.ProcessEnv;
    stderr?: (chunk: string) => void;
    version?: string;
  } = {},
  dependencies: UpdateDependencies = {},
): Promise<UpdateResult> {
  const env = options.env ?? process.env;
  const currentVersion = resolveCurrentVersion(env);
  const latestVersion =
    options.version === undefined
      ? await fetchLatestVersion(env, dependencies.fetch)
      : normalizeReleaseVersion(options.version);
  const updateAvailable = latestVersion !== currentVersion;
  const checkedOnly = options.checkOnly === true;

  if (checkedOnly || !updateAvailable) {
    return {
      checkedOnly,
      currentVersion,
      latestVersion,
      updateAvailable,
      updated: false,
    };
  }

  const runner = dependencies.runInstaller ?? runReleaseInstaller;
  await runner({
    env,
    installUrl: env.MEGA_WALLET_CLI_INSTALL_URL ?? defaultInstallUrl,
    stderr: options.stderr,
    version: latestVersion,
  });

  return {
    checkedOnly,
    currentVersion,
    latestVersion,
    updateAvailable,
    updated: true,
  };
}

function resolveCurrentVersion(env: NodeJS.ProcessEnv): string {
  const installedVersion = env.MEGA_WALLET_CLI_INSTALLED_VERSION?.trim();
  if (installedVersion !== undefined && installedVersion.length > 0) {
    return normalizeReleaseVersion(installedVersion);
  }

  return cliReleaseVersion;
}

async function fetchLatestVersion(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const repo = env.MEGA_WALLET_CLI_REPO ?? defaultRepo;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new CliError("MEGA_WALLET_CLI_REPO must be OWNER/REPO");
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "mega-moss-cli",
        ...(env.GITHUB_TOKEN === undefined
          ? {}
          : { Authorization: `Bearer ${env.GITHUB_TOKEN}` }),
      },
    },
  );
  if (!response.ok) {
    throw new CliError(
      `failed to check latest release: HTTP ${response.status}`,
    );
  }

  const body = (await response.json()) as { tag_name?: unknown };
  if (typeof body.tag_name !== "string") {
    throw new CliError("latest release response did not include tag_name");
  }

  return normalizeReleaseVersion(body.tag_name);
}

async function runReleaseInstaller(options: {
  env: NodeJS.ProcessEnv;
  installUrl: string;
  stderr?: (chunk: string) => void;
  version: string;
}): Promise<void> {
  const response = await fetch(options.installUrl);
  if (!response.ok) {
    throw new CliError(
      `failed to download installer: HTTP ${response.status}`,
    );
  }

  const script = await response.text();
  await execInstallerScript(script, options);
}

async function execInstallerScript(
  script: string,
  options: {
    env: NodeJS.ProcessEnv;
    stderr?: (chunk: string) => void;
    version: string;
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "sh",
      ["-s", "--", "--version", options.version],
      {
        env: options.env,
        maxBuffer: 1024 * 1024 * 16,
      },
      (error, stdout, stderr) => {
        if (stdout.length > 0) {
          options.stderr?.(stdout);
        }
        if (stderr.length > 0) {
          options.stderr?.(stderr);
        }
        if (error) {
          reject(new CliError(`update failed: ${error.message}`));
          return;
        }
        resolve();
      },
    );

    child.stdin?.end(script);
  });
}

function normalizeReleaseVersion(value: string): string {
  const version = value.trim();
  const normalized = version.startsWith("v") ? version : `v${version}`;
  if (!/^v[0-9A-Za-z][0-9A-Za-z._-]*$/.test(normalized)) {
    throw new CliError(`invalid release version: ${value}`);
  }

  return normalized;
}
