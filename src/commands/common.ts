import { defaultNetwork, isNetwork, type Network } from "../config/chains.js";
import { CliError } from "../errors.js";

const configDirEnvVar = "MEGA_WALLET_CLI_CONFIG_DIR";

export type OutputWriter = {
  columns?: number;
  isTTY?: boolean;
  write(chunk: string): unknown;
};

export type ConfigDirCommandOptions = {
  configDir?: string;
};

export function normalizeNetwork(value: string | undefined): Network {
  const network = value ?? defaultNetwork;
  if (!isNetwork(network)) {
    throw new CliError(`unsupported network: ${network}`);
  }

  return network;
}

export function parsePositiveInteger(
  value: string,
  message = "value must be a positive integer",
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(message);
  }

  return parsed;
}

export function parsePositiveIntegerOption(value: string): number {
  return parsePositiveInteger(value);
}

export function assertHttpUrl(value: string, message: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new CliError(message);
  }
}

export function resolveCommandEnv(
  options: ConfigDirCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (options.configDir === undefined) {
    return env;
  }

  const configDir = options.configDir.trim();
  if (configDir.length === 0) {
    throw new CliError("config-dir must not be empty");
  }

  return {
    ...env,
    [configDirEnvVar]: configDir,
  };
}
