import { homedir, platform } from "node:os";
import { join } from "node:path";

import type { Network } from "./chains.js";

const configDirEnvVar = "MEGA_WALLET_CLI_CONFIG_DIR";

export type ConfigPaths = {
  rootDir: string;
  profilesDir: string;
};

export function getConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[configDirEnvVar];
  if (override && override.trim().length > 0) {
    return override;
  }

  if (platform() === "win32") {
    return join(
      env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "megaeth",
      "wallet-cli",
    );
  }

  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "megaeth",
      "wallet-cli",
    );
  }

  return join(homedir(), ".config", "megaeth", "wallet-cli");
}

export function getConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
): ConfigPaths {
  const rootDir = getConfigRoot(env);

  return {
    rootDir,
    profilesDir: join(rootDir, "profiles"),
  };
}

export function getProfilePath(
  network: Network,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(getConfigPaths(env).profilesDir, network, "default.json");
}
